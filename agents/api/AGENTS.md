# minimal-agent API

Hono API wrapper around the agent harness from `basically-ai-harness/agent/`
(`1-tools.ts`, `2-model.ts`, `3-context.ts`, `5-loop.ts`, `browser.ts` — vendored
into `src/harness/`, plus `exa.ts` for the Exa API backend). Intended to be consumed by the OpenTUI client in
`../opentui/`.

## Setup

```sh
bun install
cp .env.example .env   # OPENAI_API_KEY, plus EXA_API_KEY for the exa backend
bun run dev            # http://localhost:3000
```

## Endpoints

| Method | Path            | Description |
| ------ | --------------- | ----------- |
| GET    | `/api/models`   | Model catalogue + default model |
| GET    | `/health`       | Liveness probe (Docker `HEALTHCHECK`) |
| GET    | `/api/tools?provider=chromium\|exa` | Tool names for that backend; also lists available providers |
| POST   | `/api/run`      | Run the agent harness on a task; JSON by default, SSE with `accept: text/event-stream` |
| DELETE | `/api/runs/:id` | Abort an in-flight run |

### POST /api/run

```jsonc
{
  "task": "Go to https://news.ycombinator.com and list the top 3 story titles.",
  "model": "openai/gpt-oss-20b",   // optional, must be in GET /api/models
  "effort": "medium",              // optional, must be listed in that model's "efforts"
  "systemPrompt": "...",           // optional, overrides default
  "tools": "chromium",             // "chromium" (local Playwright) | "exa" (Exa web API)
  "maxIterations": 15,             // optional, guardrail iteration cap per attempt
  "maxAttempts": 1,                // optional, retries when verify fails
  "verify": false                  // optional, require >=1 successful tool call
}
```

Response: `{ runId, task, model, answer, iterations, trace, stoppedBy, attempts, verification }`
where each trace entry is
`{ index, outcome: "tool_calls" | "answer", toolEvents, contextSize, contextTrimmed }`.

Response is the same JSON shape, returned only once the run finishes.

#### Streaming (SSE)

Send `accept: text/event-stream` to receive progress as it happens. The response
body is a `text/event-stream`; plain JSON stays the default, so existing clients
are unaffected.

| `event:`        | `data:` |
| --------------- | ------- |
| `iteration`     | `{ iteration, finishReason }` — one per model call |
| `tool_call`     | `{ iteration, tool, args }` — emitted before the tool runs |
| `tool_result`   | `{ tool, result }` — in call order |
| `answer_delta`  | `{ delta }` — answer tokens as they arrive |
| `done`          | `{ runId, ...result }` — the full JSON response above |
| `error`         | `{ runId, error }` — failures after the stream opened |

Streaming is enabled per request by supplying an `onAnswerDelta` hook, which
switches the model call to `stream: true` and reassembles tool-call fragments;
the non-streaming path is untouched.

### Example

```sh
# one-shot JSON
curl -s localhost:3000/api/run -H 'content-type: application/json' \
  -d '{"task":"Get the current URL after navigating to https://example.com"}'

# live tokens
curl -sN localhost:3000/api/run -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"task":"Go to https://example.com and tell me the heading.","tools":"chromium"}'
```

## Notes

- Each `/api/run` request gets its own Playwright Chromium session
  (headless by default; set `BROWSER_HEADLESS=false` to watch the window).
- Model calls go through an OpenAI-compatible provider —
  `OPENAI_API_KEY` (Groq) or `OPENROUTER_API_KEY` in `.env`.
- Guardrails: iteration cap (`maxIterations`, default 15) and context cap
  (50 messages) stop runaway loops; `stoppedBy: "guardrail"` in the response.
- Harness: optional `verify: true` requires ≥1 successful tool call,
  retries up to `maxAttempts` times otherwise.
- Tool calls and errors are returned in `trace`, not thrown — only
  browser/model failures produce non-200 responses.
- Every request is logged to the terminal running `bun run dev` by Hono's
  builtin `logger()` middleware (`GET /api/models 200 1ms`).

## OpenTUI client

`../opentui/` is a terminal client for this API (termcn `app-shell`):

```sh
cd ../opentui && bun run dev
```

- Type a task → streams trace lines, then the answer.
- `/model [model-id]` — show or choose the provider model (the next run uses it).
- `/effort [low|medium|high]` — show or choose reasoning effort (sent as
  `reasoning_effort` to the provider); only models that list `efforts` accept it.
- `/tools` opens a backend picker (`chromium` | `exa`); `/tools exa` lists that
  backend's tool names.
- `/help`, `/exit`.
- The model list and each model's allowed efforts are fetched from
  `GET /api/models`; the TUI has no hardcoded catalogue.

## Production

See `../README.md` for Docker Compose, reverse-proxy setup, and GitHub
publishing.
