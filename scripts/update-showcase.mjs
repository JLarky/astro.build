import ghActions from "@actions/core"
import octokit from "@octokit/graphql"
import matter from "gray-matter"
import { parseHTML } from "linkedom"
import fs from "node:fs/promises"
import puppeteer from "puppeteer"
import { downloadBrowser } from "puppeteer/lib/esm/puppeteer/node/install.js"
import sharp from "sharp"

await downloadBrowser()

class ShowcaseScraper {
	/** A GraphQL client that uses our authorization token by default. */
	#query
	/** The GitHub user or org to scrape. */
	#org
	/** The name of the GitHub repo to scrape. */
	#repo
	/** The number of the discussion to use as the data source. */
	#discussion
	/** Array of origins that should never be added to the showcase. */
	#blocklist

	constructor({ org = "withastro", repo = "roadmap", discussion = 521, blockedOrigins = [] } = {}) {
		if (!process.env.GITHUB_TOKEN) {
			throw new Error("GITHUB_TOKEN env variable must be set to run.")
		}
		this.#query = octokit.graphql.defaults({
			headers: {
				authorization: `token ${process.env.GITHUB_TOKEN}`,
			},
		})
		this.#org = org
		this.#repo = repo
		this.#discussion = discussion
		this.#blocklist = new Set(blockedOrigins.map((url) => new URL(url).origin))
	}

	/**
	 * Run the showcase scraper, extract & filter links from the GitHub discussion,
	 * test they are pointing to Astro sites, and add new ones to the repo.
	 * @returns {Promise<void>}
	 */
	async run() {
		console.log(
			`Fetching comments from ${this.#org}/${this.#repo} discussion #${this.#discussion}...`,
		)
		const commentHtml = await this.#getDiscussionCommentsHTML()
		console.log("Extracting URLs...")
		const hrefs = await this.#filterHrefs(this.#extractHrefs(commentHtml))

		/** @type {{ astro: string[]; nonAstro: string[]; scraped: { url: string; title: string | undefined }[]; failed: string[] }} */
		const sites = { astro: [], nonAstro: [], scraped: [], failed: [] }
		console.log(`Searching ${hrefs.length} URL(s) for sites built with Astro...`)
		for (const href of hrefs) {
			const isAstroSite = await ShowcaseScraper.#isAstro(href)
			sites[isAstroSite ? "astro" : "nonAstro"].push(href)
		}

		console.log(`Scraping ${sites.astro.length} new Astro site(s)...`)
		const browser = await puppeteer.launch()
		for (const url of sites.astro) {
			const { success, title } = await ShowcaseScraper.#addShowcaseSite(url, browser)
			if (success) {
				sites.scraped.push({ title, url })
			} else {
				sites.failed.push(url)
			}
		}

		this.setActionOutput(sites)

		await browser.close()
	}

	/**
	 * Expose data from this run to GitHub Actions for use in other steps.
	 * We set a `prBody` output for use when creating a PR from this run’s changes.
	 * @param {{
	 * 	scraped: { url: string; title: string | undefined }[];
	 * 	failed: string[];
	 * 	nonAstro: string[]
	 * }} sites
	 */
	setActionOutput(sites) {
		const prLines = [
			"This PR is auto-generated by a GitHub action that runs every Monday to update the Astro showcase with data from GitHub and NPM.",
			"",
		]
		if (sites.scraped.length > 0) {
			prLines.push(
				"#### Sites added in this PR 🆕",
				"",
				...sites.scraped.map(({ title, url }) => `- [${title}](${url})`),
				"",
			)
		}
		if (sites.failed.length > 0) {
			prLines.push(
				"#### Sites that failed while scraping 🚨",
				"",
				"These sites are new additions and appear to be built with Astro, but something went wrong while trying to scrape them. You might want to add them to the showcase manually.",
				"",
				...sites.failed.map((url) => `- ${url}`),
				"",
			)
		}
		if (sites.nonAstro.length > 0) {
			prLines.push(
				"#### Sites that are maybe not built with Astro 🤔",
				"",
				"We couldn’t detect that these sites were built with Astro. You might want to check manually.",
				"",
				sites.nonAstro.join(", "),
			)
		}

		ghActions.setOutput("prBody", prLines.join("\n"))
	}

	/**
	 * Execute a GraphQL query to fetch discussion comments from the GitHub API.
	 * @returns {Promise<{
	 *  repository: {
	 *    discussion: {
	 *      bodyHTML: string;
	 *      comments: {
	 *        pageInfo: {
	 *          startCursor: string;
	 *          endCursor: string;
	 *          hasNextPage: boolean;
	 *        }
	 *        nodes: {
	 *          bodyHTML: string
	 *        }[]
	 *      }
	 *    }
	 *  }
	 * }>}
	 */
	#getDiscussionComments({ first = 100, after = "null" } = {}) {
		return this.#query(`query {
     repository(owner: "${this.#org}", name: "${this.#repo}") {
       discussion(number: ${this.#discussion}) {
         bodyHTML
         comments(first: ${first}, after: ${after ? '"' + after + '"' : "null"}) {
           pageInfo {
             startCursor
             endCursor
             hasNextPage
            }
            nodes {
              bodyHTML
            }
          }
        }
      }
    }`)
	}

	/**
	 * Get a string of the HTML of all comments in a specific GitHub Discussion
	 * @returns {Promise<string>}
	 */
	async #getDiscussionCommentsHTML() {
		/** @type {string[]} */
		const allCommentsHTML = []
		let hasNextPage = true
		let after = ""
		while (hasNextPage) {
			const { repository } = await this.#getDiscussionComments({ after })
			const { bodyHTML, comments } = repository.discussion

			// Add main discussion comment on first run
			if (!after) allCommentsHTML.push(bodyHTML)

			comments.nodes.forEach((node) => allCommentsHTML.push(node.bodyHTML))

			hasNextPage = comments.pageInfo.hasNextPage
			after = comments.pageInfo.endCursor
		}
		return allCommentsHTML.join("")
	}

	/**
	 * @param {string} html HTML to parse and extract links from
	 * @returns {string[]} Array of URLs found in link `href` attributes.
	 */
	#extractHrefs(html) {
		const { document } = parseHTML(html)
		const links = document.querySelectorAll("a")
		const hrefs = [...links].map((link) => link.href).filter((href) => Boolean(href))
		return [...new Set(hrefs)]
	}

	/**
	 * Filter out URLs we already added or that are excluded by the list of blocked origins.
	 * @param {string[]} hrefs Array of URLs as returned by `#extractHrefs`.
	 * @returns {Promise<string[]>}
	 */
	async #filterHrefs(hrefs) {
		const currentSites = await ShowcaseScraper.#getLiveShowcaseUrls()
		return hrefs.filter((href) => {
			const { origin } = new URL(href)
			return !this.#blocklist.has(origin) && !currentSites.has(origin)
		})
	}

	/**
	 * @param {URL} url URL to test
	 * @returns {boolean}
	 */
	static #isAstroAssetURL({ pathname }) {
		return (
			// default Astro v2 assets directory
			pathname.startsWith("/_astro/") ||
			// any JS file that matches the `hoisted.{hash}.js` pattern
			/\/hoisted\.[a-z0-9]+\.js$/.test(pathname) ||
			// old Astro v1 style hashed files in `/assets/` directory
			/^\/assets\/.+\.[a-z0-9_]+\.(css|js|jpeg|jpg|webp|avif|png)$/.test(pathname)
		)
	}

	/**
	 * Try to decide if a given webpage is built with Astro
	 * @param {string | URL} url URL to test
	 * @returns Promise<boolean>
	 */
	static async #isAstro(url) {
		let raw = ""
		try {
			const res = await fetch(url)
			raw = await res.text()
		} catch (error) {
			console.error("Failed to fetch", url)
			return false
		}

		const { document } = parseHTML(raw)

		const generator = document.querySelector('meta[name="generator"]')
		if (generator && generator.getAttribute("content")?.startsWith("Astro")) {
			return true
		}

		if (
			document.querySelector("astro-island") ||
			document.querySelector('[class*="astro-"]') ||
			document.querySelector("[astro-script]")
		) {
			return true
		}

		const hrefEls = document.querySelectorAll("[href]")
		for (const el of hrefEls) {
			const href = el.getAttribute("href")
			if (href && ShowcaseScraper.#isAstroAssetURL(new URL(href, import.meta.url))) {
				return true
			}
		}

		const srcEls = document.querySelectorAll("[src]")
		for (const el of srcEls) {
			const src = el.getAttribute("src")
			if (src && ShowcaseScraper.#isAstroAssetURL(new URL(src, import.meta.url))) {
				return true
			}
		}

		return false
	}

	/**
	 * Fetch URLs from live `/api/showcase.json`.
	 * @returns {Promise<Set<string>>}
	 */
	static async #getLiveShowcaseUrls() {
		const showcaseJsonUrl = "https://astro.build/api/showcase.json"
		/** @type {{ title: string; url: string }[]} */
		let data = []
		try {
			const res = await fetch(showcaseJsonUrl)
			const json = await res.json()
			data = json
		} catch {
			console.error("Failed to fetch", showcaseJsonUrl)
		}
		return new Set(data.map(({ url }) => new URL(url).origin))
	}

	/**
	 * Add a URL to the Astro showcase, scraping the site, and creating a data file and screenshots.
	 * @param {string} url URL to visit
	 * @param {import('puppeteer').Browser} browser
	 * @returns {Promise<{ success: boolean; title: string | undefined }>}
	 */
	static async #addShowcaseSite(url, browser) {
		console.group("Scraping", url)
		/** @type {string | undefined} */
		let title
		let success = false
		try {
			const site = await ShowcaseScraper.#scrapeSite(url, browser)
			await ShowcaseScraper.#saveScreenshots(url, site.screenshot)
			await ShowcaseScraper.#saveDataFile(url, site.title)
			title = site.title
			success = true
		} catch {
			console.error("Scraping failed.")
		}
		console.groupEnd()
		return { success, title }
	}

	/**
	 * Loads the URL with Puppeteer to extract the page title and take a screenshot.
	 * @param {string} url URL of the page to visit
	 * @param {import('puppeteer').Browser} browser
	 * @returns {Promise<{ screenshot: Buffer; title: string }>}
	 */
	static async #scrapeSite(url, browser) {
		const page = await browser.newPage()
		await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.4 })
		await page.goto(url)
		// Some pages animate elements in on load, so we give them some time to settle:
		// wait for 2 seconds + 1 frame, then wait for page to be idle.
		await page.evaluate(() => {
			return new Promise((resolve) => {
				setTimeout(() => requestAnimationFrame(() => requestIdleCallback(resolve)), 2000)
			})
		})
		const title = await page.title()
		const screenshot = await page.screenshot()
		await page.close()
		return { screenshot, title }
	}

	/**
	 * Resize screenshot buffer, convert it  to `.webp`, and save it to disk.
	 * @param {string} url URL for this screenshot
	 * @param {Buffer} screenshot PNG image buffer
	 * @returns {Promise<void>}
	 */
	static async #saveScreenshots(url, screenshot) {
		const { hostname } = new URL(url)
		const pipeline = sharp(screenshot)
		await pipeline
			.clone()
			.resize(1600)
			.webp()
			.toFile(`src/content/showcase/_images/${hostname}@2x.webp`)
		console.log("Wrote", `src/content/showcase/_images/${hostname}@2x.webp`)
		await pipeline.resize(800).webp().toFile(`src/content/showcase/_images/${hostname}.webp`)
		console.log("Wrote", `src/content/showcase/_images/${hostname}.webp`)
	}

	/**
	 * Create a Markdown file in the showcase content collection.
	 * @param {string} url URL of the showcase entry to link to
	 * @param {string} title Title of the showcase site
	 * @returns {Promise<void>}
	 */
	static async #saveDataFile(url, title) {
		const { hostname } = new URL(url)
		const file = matter.stringify("", {
			title,
			image: `/src/content/showcase/_images/${hostname}.webp`,
			url,
		})
		await fs.writeFile(`src/content/showcase/${hostname}.md`, file, "utf-8")
		console.log("Wrote", `src/content/showcase/${hostname}.md`)
	}
}

const scraper = new ShowcaseScraper({
	org: "withastro",
	repo: "roadmap",
	discussion: 521,
	blockedOrigins: [
		"https://github.com",
		"https://user-images.githubusercontent.com",
		"https://camo.githubusercontent.com",
		"https://astro.build",
	],
})
await scraper.run()
