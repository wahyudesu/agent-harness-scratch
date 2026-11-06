import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { BrowserSession } from "./browser.js";
import { ExaSession } from "./exa.js";

export type Tool = {
  definition: ChatCompletionTool;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

export type ToolRegistry = {
  definitions: ChatCompletionTool[];
  byName: Map<string, Tool>;
};

/** Tool backend selected per run. */
export type ToolProvider = "chromium" | "exa";

export type ToolSession = {
  close(): Promise<void>;
};

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

/** Local browser: drives a real Chromium page through Playwright. */
function chromiumTools(session: BrowserSession): Tool[] {
  return [
    {
      definition: fn(
        "browser_search",
        "Search the web when you do not already know the URL. Opens a search engine results page and returns its text: titles, snippets, and links. Read a result with browser_navigate, then browser_get_text.",
        {
          query: { type: "string", description: "What to search for." },
          engine: {
            type: "string",
            enum: ["bing", "google"],
            description: "Optional; defaults to bing. Google often blocks automated browsers.",
          },
        },
        ["query"],
      ),
      execute: async ({ query, engine }) =>
        session.search(query as string, engine === "google" ? "google" : "bing"),
    },
    {
      definition: fn(
        "browser_navigate",
        "Navigate the browser to a URL.",
        { url: { type: "string" } },
        ["url"],
      ),
      execute: async ({ url }) => session.navigate(url as string),
    },
    {
      definition: fn("browser_url", "Get the URL of the current page (detects redirects)."),
      execute: async () => session.getUrl(),
    },
    {
      definition: fn("browser_get_text", "Get the visible text content of the current page."),
      execute: async () => session.getText(),
    },
    {
      definition: fn(
        "browser_click",
        "Click an element on the current page and wait for any resulting navigation.",
        { selector: { type: "string", description: "CSS selector" } },
        ["selector"],
      ),
      execute: async ({ selector }) => session.click(selector as string),
    },
    {
      definition: fn(
        "browser_fill",
        "Fill an input field on the current page.",
        { selector: { type: "string" }, value: { type: "string" } },
        ["selector", "value"],
      ),
      execute: async ({ selector, value }) => session.fill(selector as string, value as string),
    },
  ];
}

/**
 * Exa web API: reads the web without a browser. Tuned for how an agent uses
 * search — the query carries the intent, and results come back as token-cheap
 * highlights plus URLs the model can read in full with web_fetch.
 */
function exaTools(session: ExaSession): Tool[] {
  return [
    {
      definition: fn(
        "web_search",
        "Search the web semantically. Returns titles, URLs, and highlighted excerpts. Put the subject, constraints, and time window in the query.",
        {
          query: { type: "string", description: "Natural-language search query." },
          numResults: {
            type: "number",
            description: "Optional result count; omit to use the API default (10).",
          },
        },
        ["query"],
      ),
      execute: async ({ query, numResults }) =>
        session.search(query as string, numResults as number | undefined),
    },
    {
      definition: fn(
        "web_fetch",
        "Read the content of known URLs.",
        { urls: { type: "array", items: { type: "string" }, description: "1-10 absolute URLs." } },
        ["urls"],
      ),
      execute: async ({ urls }) => session.fetch(urls as string[]),
    },
  ];
}

/**
 * Open a tool backend for one run. Callers must `close()` it: Chromium holds a
 * browser process per run.
 */
export async function openTools(provider: ToolProvider): Promise<{
  session: ToolSession;
  registry: ToolRegistry;
}> {
  if (provider === "exa") {
    const session = new ExaSession();
    const tools = exaTools(session);
    return { session, registry: toRegistry(tools) };
  }

  // BROWSER_HEADLESS=false opens a visible Chromium window (useful while
  // debugging tool calls locally); anything else, including unset, stays headless.
  const session = new BrowserSession(process.env.BROWSER_HEADLESS !== "false");
  await session.open();
  const tools = chromiumTools(session);
  return { session, registry: toRegistry(tools) };
}

const toRegistry = (tools: Tool[]): ToolRegistry => ({
  definitions: tools.map((t) => t.definition),
  byName: new Map(tools.map((t) => [t.definition.function.name, t])),
});
