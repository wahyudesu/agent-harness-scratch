import Exa from "exa-js";

import type { ToolSession } from "./4-tools.js";

/**
 * Web tooling through Exa's API instead of a local browser. No Chromium means
 * a much smaller production image and no browser memory per run.
 *
 * Request shape follows Exa's guidance: intent goes in the query, content
 * extraction is bare `highlights: true` (Exa sizes excerpts per page), and
 * nothing else is sent unless the caller asked for it.
 */
export class ExaSession implements ToolSession {
  private readonly client: Exa;

  constructor() {
    this.client = new Exa(process.env.EXA_API_KEY ?? "missing");
  }


  async search(query: string, numResults?: number): Promise<string> {
    const response = await this.client.search(query, {
      type: "auto",
      contents: { highlights: true },
      ...(numResults ? { numResults } : {}),
    });

    const results = response.results.map((r) => ({
      title: r.title ?? "(no title)",
      url: r.url,
      published: r.publishedDate ?? undefined,
      highlights: r.highlights ?? [],
    }));

    return JSON.stringify({ results }, null, 2);
  }

  async fetch(urls: string[]): Promise<string> {
    // The contents endpoint takes extraction fields at the top level, unlike
    // /search where they nest under `contents`.
    const response = await this.client.getContents(urls, {
      highlights: true
    });

    const results = response.results.map((r) => ({
      url: r.url,
      title: r.title ?? "(no title)",
      highlights: r.highlights ?? [],
    }));

    return JSON.stringify({ results }, null, 2);
  }

  async close(): Promise<void> {
    // The SDK is stateless; nothing to tear down.
  }
}
