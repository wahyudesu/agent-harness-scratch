# minimal agent harness

A small, readable agent harness: an OpenAI-compatible model, an LLM loop with
guardrails, and a Hono API in front of it. Tools come from one of two backends —
a local Chromium browser or the Exa web API — and the TUI in
`minimal-agent/opentui` is the reference consumer.

```
agent/minimal-agent/
├── api/                       Hono server (production target)
│   ├── src/index.ts           routes: /api/models, /api/run, /api/tools, …
│   └── src/harness/
│       ├── 1-tools.ts         tool definitions + executors
│       ├── 2-model.ts         provider client, model catalogue
│       ├── 3-context.ts       system prompt, tool list, trimming
│       ├── 4-guardrails.ts    iteration/context caps, composition
│       ├── 5-loop.ts          the inference loop
│       ├── 6-harness.ts       per-attempt session + verify/retry
│       ├── browser.ts         Playwright session (chromium backend)
│       └── exa.ts             Exa API session (exa backend)
├── opentui/                   terminal client (fetches the model list from the API)
├── docker-compose.yml         production stack
└── README.md
```

Every section below quotes the actual code, so you can lift a file wholesale or
copy just the pattern.

---

## 1. Model

The provider is OpenAI-compatible, so only `baseURL` and `apiKey` change.
Keeping both in the environment means a deployment can point at Groq,
OpenRouter, or a self-hosted gateway without a code change.

```typescript
// api/src/harness/2-model.ts
import OpenAI from "openai";
import "dotenv/config";

export const getClient = (): OpenAI =>
  new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "missing",
  });
```

The model catalogue also lives here, because the API owns it and clients fetch
it instead of hardcoding model ids:

```typescript
export type Effort = "low" | "medium" | "high";

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  context: number;
  efforts: Effort[];
};

export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-oss-20b", name: "gpt-oss-20b", provider: "Groq", context: 131072, efforts: ["low", "medium", "high"] },
  { id: "openai/gpt-oss-120b", name: "gpt-oss-120b", provider: "Groq", context: 131072, efforts: ["low", "medium", "high"] },
  { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b", provider: "Groq", context: 131072, efforts: [] },
];

export const DEFAULT_MODEL = MODELS[0]!.id;
export const isKnownModel = (id: string): boolean => MODELS.some((m) => m.id === id);
```

Add a model by adding one row; the TUI picker and `/effort` options follow
automatically.

## 2. Tools

A tool is a JSON schema plus an async executor that returns a string. The same
registry shape serves both backends, chosen per run with `tools`:

| `tools` | Tools | Needs |
| --- | --- | --- |
| `chromium` (default) | `browser_navigate`, `browser_url`, `browser_get_text`, `browser_click`, `browser_fill` | nothing beyond the image |
| `exa` | `web_search`, `web_fetch` | `EXA_API_KEY` |

`openTools()` returns the session (for cleanup) and the registry the loop
consumes:

```typescript
// api/src/harness/1-tools.ts
export async function openTools(provider: ToolProvider): Promise<{
  session: ToolSession;
  registry: ToolRegistry;
}> {
  if (provider === "exa") {
    const session = new ExaSession();
    return { session, registry: toRegistry(exaTools(session)) };
  }

  const session = new BrowserSession(process.env.BROWSER_HEADLESS !== "false");
  await session.open();
  return { session, registry: toRegistry(chromiumTools(session)) };
}
```

Executors close over that run's session, because the session owns the state
(the open page, or the API client):

```typescript
// api/src/harness/1-tools.ts (chromium backend)
{
  definition: fn(
    "browser_navigate",
    "Navigate the browser to a URL.",
    { url: { type: "string" } },
    ["url"],
  ),
  execute: async ({ url }) => session.navigate(url as string),
}
```

The Chromium session is a thin Playwright wrapper:

```typescript
// api/src/harness/browser.ts
async open(): Promise<void> {
  this.browser = await chromium.launch({ headless: this.headless });
  this.page = await (await this.browser.newContext()).newPage();
}

async navigate(url: string, timeoutMs = 15000): Promise<string> {
  await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  return `Navigated to ${url}`;
}
```

The Exa backend trades the browser for two API calls. Follow Exa's request
guidance: intent in the query, bare `highlights: true`, nothing else unless the
caller asked for it. `maxAgeHours: 0` forces a live crawl so answers are not
built from a stale cache.

```typescript
// api/src/harness/exa.ts
async search(query: string, numResults?: number): Promise<string> {
  const response = await this.client.search(query, {
    type: "auto",
    contents: { highlights: true, maxAgeHours: 0 },
    ...(numResults ? { numResults } : {}),
  });
  // → JSON: { results: [{ title, url, published, highlights }] }
}

async fetch(urls: string[]): Promise<string> {
  // /contents takes extraction fields at the top level, unlike /search.
  const response = await this.client.getContents(urls, { highlights: true, maxAgeHours: 0 });
}
```

Picking a backend matters beyond cost: `chromium` can log in, click, and read
pages behind interaction; `exa` is cheaper, needs no browser memory, and cannot
be blocked by bot protection. Use `chromium` for UI flows, `exa` for research.

## 3. Context

The system prompt names every available tool. Without that, models invent tool
names (for example `browser_search`) and the provider rejects the request with
a 400 before the loop can react.

```typescript
// api/src/harness/3-context.ts
export function createContext(
  task: string,
  systemPrompt?: string,
  toolNames?: string[],
): ChatCompletionMessageParam[] {
  const availableTools = toolNames?.length
    ? `\n\nYou have EXACTLY these tools — never call any tool not in this list:\n${toolNames
        .map((n) => `- ${n}`)
        .join("\n")}`
    : "";
  return [
    { role: "system", content: (systemPrompt ?? SYSTEM_PROMPT) + availableTools },
    { role: "user", content: task },
  ];
}
```

Trimming keeps the system prompt and the original task, and drops the oldest
tool messages first:

```typescript
export function trimContext(
  messages: ChatCompletionMessageParam[],
  maxMessages: number,
): ChatCompletionMessageParam[] {
  if (messages.length <= maxMessages) return messages;
  const [system, user] = messages;
  const rest = messages.slice(2);
  return [system, user, ...rest.slice(rest.length - (maxMessages - 2))];
}
```

## 4. Guardrails

Each check is a pure function `input -> ok | {reason}`. Composition stops at the
first failure; the reason becomes the run's answer with `stoppedBy: "guardrail"`.

```typescript
// api/src/harness/4-guardrails.ts
export function maxIterations(
  limit: number,
): (input: { iterations: number }) => { ok: true } | { ok: false; reason: string } {
  return ({ iterations }) =>
    iterations >= limit
      ? { ok: false, reason: `Guardrail: reached iteration limit (${limit})` }
      : { ok: true };
}

export function combineGuardrails(...fns: GuardrailFn[]): GuardrailFn {
  return (input) => {
    for (const check of fns) {
      const result = check(input);
      if (!result.ok) return result;
    }
    return { ok: true };
  };
}

export const defaultGuardrails = combineGuardrails(maxIterations(15), maxMessages(50));
```

## 5. Agent loop

One iteration = one model call. `finish_reason` decides what happens next:
`stop` ends the run, `tool_calls` executes every call, appends each result as a
`tool` message, and loops. Every iteration is traced so callers can show what
happened.

```typescript
// api/src/harness/5-loop.ts
while (true) {
  signal?.throwIfAborted();

  messages = trimContext(messages, MAX_CONTEXT_MESSAGES);
  const check = guardrail({ iterations: trace.length, messages });
  if (!check.ok) return { answer: check.reason, iterations: trace.length, trace, stoppedBy: "guardrail" };

  const response = await getClient().chat.completions.create(
    { model, messages, tools: tools.definitions, ...(effort ? { reasoning_effort: effort } : {}) },
    { signal },
  );
  const choice = response.choices[0]!;
  messages.push(choice.message as ChatCompletionMessageParam);

  if (choice.finish_reason === "stop") {
    trace.push({ index: trace.length + 1, outcome: "answer", toolEvents: [] });
    return { answer: choice.message.content ?? "(no response)", iterations: trace.length, trace, stoppedBy: "model" };
  }

  if (choice.finish_reason === "tool_calls") {
    const toolEvents: ToolEvent[] = [];
    for (const call of choice.message.tool_calls ?? []) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      let result: string;
      try {
        const tool = tools.byName.get(name);
        result = tool ? await tool.execute(args) : `Unknown tool: "${name}"`;
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      toolEvents.push({ tool: name, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    trace.push({ index: trace.length + 1, outcome: "tool_calls", toolEvents });
  }
}
```

## 6. Verification and retry

Verification runs once per attempt and can veto the answer. `fatal` skips the
retry when retrying cannot help, for example when every tool call already failed.

```typescript
// api/src/harness/6-harness.ts
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const result = await runHarnessAttempt(task, model, options);
  const verification = options.verify ? options.verify(result) : null;
  const answer = verification && !verification.passed ? verification.reason : result.answer;
  const final = { ...result, answer, attempts: attempt, verification };

  if (!verification || verification.passed || verification.fatal || attempt === maxAttempts) {
    return final;
  }
}
```

The built-in verifier requires at least one successful tool call, because a
browser task answered without touching the browser is usually ungrounded:

```typescript
// api/src/index.ts
const verifyToolCallHappened = (result: LoopResult): VerifyResult => {
  const events = result.trace.flatMap((iteration) => iteration.toolEvents);
  const successful = events.find((event) => !event.result.startsWith("Error:"));
  return successful
    ? { passed: true, reason: `Tool call confirmed: ${successful.tool}` }
    : { passed: false, reason: "No successful tool call found", fatal: events.length > 0 };
};
```

## 7. HTTP surface

```typescript
// api/src/index.ts
app.get("/api/models", (c) => c.json({ default: DEFAULT_MODEL, models: MODELS }));

app.post("/api/run", async (c) => {
  const body = RunRequest.parse(await c.req.json());   // zod, 400 on bad input
  if (!isKnownModel(body.model)) return c.json({ error: "unknown model" }, 400);
  // …effort support check, then runHarness() with an AbortController
});
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/models` | Model catalogue + default model (what clients render) |
| `GET` | `/api/tools?provider=chromium\|exa` | Tool names for that backend, plus the provider list |
| `POST` | `/api/run` | Run a task; returns answer, trace, attempts, verification |
| `DELETE` | `/api/runs/:id` | Abort an in-flight run |
| `GET` | `/health` | Liveness probe (Docker `HEALTHCHECK`) |

## 8. Client side

The terminal client keeps no model list of its own:

```typescript
// minimal-agent/opentui/src/index.tsx
useEffect(() => {
  void (async () => {
    const res = (await apiFetch("/api/models")) as { default: string; models: ApiModel[] };
    setModels(res.models);
    setModel((current) => current || res.default);
  })();
}, []);
```

`efforts` on each model drives the `/effort` picker, and requests omit
`effort` for models that accept none. `/tools` opens a picker for the backend,
and the chosen value is sent as `tools` on every run.

The skill used to build the Exa backend is vendored at
`minimal-agent/.agents/skills/build-with-exa`
(`npx skills add exa-labs/agent-skills --skill build-with-exa`); it documents
every Exa endpoint and the request-shape pitfalls.

---

## Running it

```bash
cd agent/minimal-agent/api
cp .env.example .env          # set OPENAI_API_KEY (Groq)
bun install && bun run dev    # http://localhost:3000

cd ../opentui
bun install && bun run dev    # API_URL defaults to http://localhost:3000
```

Production: `docker compose up -d --build` from `agent/minimal-agent/` — see
[`minimal-agent/README.md`](../minimal-agent/README.md) for variables, the
reverse-proxy setup, and image publishing.

For deploying a browser agent as a long-running service (scheduled jobs, stored
sign-ins, Slack/Discord delivery), follow
https://raw.githubusercontent.com/omnara-ai/omnara/main/examples/browser-agent/SKILL.md —
it wraps this same loop with Omnara profiles and secrets.
