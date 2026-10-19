import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private headless = false) {}

  async open(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.headless });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
  }

  async navigate(url: string, timeoutMs = 15000): Promise<string> {
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    return `Navigated to ${url}`;
  }

  /**
   * Open a search results page and return its text. Bing is the default: it
   * renders for a plain headless browser, while Google commonly answers with a
   * CAPTCHA and DuckDuckGo's HTML endpoint can fail TLS in some networks.
   */
  async search(query: string, engine: "bing" | "google" = "bing"): Promise<string> {
    const encoded = encodeURIComponent(query);
    const url =
      engine === "google"
        ? `https://www.google.com/search?q=${encoded}&hl=en`
        : `https://www.bing.com/search?q=${encoded}&setlang=en`;
    await this.navigate(url);
    // Results are client-rendered after DOMContentLoaded; wait for the result
    // list itself, not a fixed delay, so a slow first paint is not read as empty.
    const resultSelector = engine === "google" ? "#search" : "#b_results, #b_no";
    await this.page!
      .locator(resultSelector)
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => undefined);
    const text = await this.page!.innerText("#b_results, #search, body");
    return `Search results for "${query}" (${engine}) at ${this.page!.url()}:\n${text.slice(0, 4000)}`;
  }

  async getUrl(): Promise<string> {
    return this.page!.url();
  }

  async getText(): Promise<string> {
    const text = await this.page!.innerText("body");
    return text.slice(0, 4000);
  }

  async fill(selector: string, value: string): Promise<string> {
    await this.page!.fill(selector, value);
    return `Filled "${selector}"`;
  }

  async click(selector: string): Promise<string> {
    // Capture the id of the element before clicking (navigation may change the page)
    const elementId = await this.page!.locator(selector).first().getAttribute("id");

    await this.page!.click(selector, { timeout: 10000 });
    await this.page!.waitForLoadState("domcontentloaded", { timeout: 10000 });

    const clicked = elementId ? `element id="${elementId}"` : `"${selector}"`;
    return `Clicked ${clicked} — now at ${this.page!.url()}`;
  }

  // Returns a structured list of HN front-page stories so the agent can
  // correlate story IDs, titles, ranks, and voted status precisely.
  async getStories(): Promise<string> {
    const stories = await this.page!.evaluate(() => {
      return Array.from(document.querySelectorAll(".athing")).map((row, i) => {
        const id = row.id;
        const title = row.querySelector(".titleline a")?.textContent?.trim() ?? "(no title)";
        const upvoteEl = document.querySelector(`#up_${id}`);
        const alreadyVoted = upvoteEl?.classList.contains("nosee") ?? true;
        return { rank: i + 1, id, title, alreadyVoted };
      });
    });
    return JSON.stringify(stories, null, 2);
  }

  async hasClass(selector: string, className: string): Promise<string> {
    const el = this.page!.locator(selector).first();
    const classes = await el.getAttribute("class") ?? "";
    const has = classes.split(" ").includes(className);
    return has ? `"${selector}" has class "${className}"` : `"${selector}" does not have class "${className}"`;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }
}
