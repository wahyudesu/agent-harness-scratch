import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { Scalar } from "@scalar/hono-api-reference";
import { z } from "zod";

import { openApiDocument } from "./openapi.js";

import { openTools, type ToolProvider } from "./harness/4-tools.js";
import { runHarness, type HarnessOptions, type VerifyResult } from "./harness/6-harness.js";
import type { LoopResult } from "./harness/5-loop.js";
import { rateLimiter } from "./rate-limit.js";
import { DEFAULT_MODEL, isKnownModel, MODELS, type Effort } from "./harness/1-model.js";

const app = new Hono();
app.use(logger());
app.use("/api/*", cors());
app.use("/api/run", rateLimiter({ windowMs: 600_000, max: 5 }));
app.use("/api/*", (c, next) =>
  new URL(c.req.url).pathname === "/api/run" ? next() : rateLimiter({ windowMs: 600_000, max: 30 })(c, next),
);

const RunRequest = z.object({
  task: z.string().min(1, "task is required"),
  /** Provider model id from GET /api/models. */
  model: z.string().default(DEFAULT_MODEL),
  /** Reasoning effort for models that support it. Omitted → provider default. */
  effort: z.enum(["low", "medium", "high"]).optional(),
  /** Optional system prompt overriding the harness default. */
  systemPrompt: z.string().optional(),
  /** Tool backend: "chromium" (local Playwright browser) or "exa" (Exa web API, needs EXA_API_KEY). */
  tools: z.enum(["chromium", "exa"]).default("chromium"),
  /** Cap on agent loop iterations per attempt before the guardrail stops it (default 15). */
  maxIterations: z.number().int().positive().default(15),
  /** Retry the whole run this many attempts when verify fails (default 1 = no retry). */
  maxAttempts: z.number().int().positive().default(1),
  /** Built-in verify: require at least one successful tool call before trusting the answer. */
  verify: z.boolean().default(false),
});

type RunBody = z.infer<typeof RunRequest>;

// Map of in-flight runs to their abort controllers, keyed by runId
const runs = new Map<string, AbortController>();

/** Progress callbacks forwarded to the agent loop; SSE mode wires them to the stream. */
type RunHooks = NonNullable<HarnessOptions["hooks"]>;

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The catalogue clients build their model pickers from. `default` marks the
 * model a run uses when the request omits `model`.
 */
app.get("/api/models", (c) =>
  c.json({ default: DEFAULT_MODEL, models: MODELS }),
);

/** Tool backends a run can use; clients show this as a picker. */
const TOOL_PROVIDERS: ToolProvider[] = ["chromium", "exa"];

/**
 * The tools each backend exposes. Definitions are static, so this lists them
 * without launching Chromium.
 */
app.get("/api/tools", async (c) => {
  const provider = (c.req.query("provider") ?? "chromium") as ToolProvider;
  if (!TOOL_PROVIDERS.includes(provider)) {
    return c.json({ error: `unknown tool provider "${provider}"` }, 400);
  }
  const { registry } = await openTools(provider);
  return c.json({
    providers: TOOL_PROVIDERS,
    exaConfigured: Boolean(process.env.EXA_API_KEY),
    provider,
    tools: registry.definitions,
  });
});

// Built-in verify: require at least one successful (non-error) tool call,
// or a tool_calls→answer run with zero tools is suspicious for a browser task.
const verifyToolCallHappened = (result: LoopResult): VerifyResult => {
  const events = result.trace.flatMap((iteration) => iteration.toolEvents);
  const successfulToolCall = events.find((event) => !event.result.startsWith("Error:"));
  if (successfulToolCall) {
    return { passed: true, reason: `Tool call confirmed: ${successfulToolCall.tool}` };
  }
  return {
    passed: false,
    reason: "No successful tool call found in trace — answer may be ungrounded",
    fatal: events.length > 0, // tools were attempted but all failed → don't retry
  };
};

/**
 * Run the agent harness on a task: guardrailed loop + optional verify/retry.
 * Each attempt opens a fresh browser session.
 */
app.post("/api/run", async (c) => {
  let body: RunBody;
  try {
    body = RunRequest.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: err instanceof z.ZodError ? err.issues : err }, 400);
  }

  if (!isKnownModel(body.model)) {
    return c.json({ error: `unknown model "${body.model}" — see GET /api/models` }, 400);
  }
  const supported: readonly Effort[] = MODELS.find((m) => m.id === body.model)?.efforts ?? [];
  if (body.effort && !supported.includes(body.effort)) {
    return c.json(
      { error: `model "${body.model}" does not support effort "${body.effort}"` },
      400,
    );
  }

  if (body.tools === "exa" && !process.env.EXA_API_KEY) {
    return c.json({ error: "tools=\"exa\" needs EXA_API_KEY on the server" }, 400);
  }

  const runId = crypto.randomUUID();
  const aborter = new AbortController();
  runs.set(runId, aborter);

  /** Shared by both transports: run the harness with the caller's options. */
  const start = (hooks?: RunHooks) =>
    runHarness(body.task, body.model, {
      provider: body.tools,
      systemPrompt: body.systemPrompt,
      maxIterations: body.maxIterations,
      maxAttempts: body.maxAttempts,
      effort: body.effort,
      signal: aborter.signal,
      verify: body.verify ? verifyToolCallHappened : undefined,
      hooks,
    });

  // Server-sent events: the client sees tokens and tool calls as they happen
  // instead of waiting for the whole run. Errors after the stream opens cannot
  // become a status code, so they travel as an `error` event.
  if (c.req.header("accept")?.includes("text/event-stream")) {
    return streamSSE(c, async (stream) => {
      const hooks: RunHooks = {
        onModelCall: (iteration, finishReason) =>
          stream.writeSSE({ event: "iteration", data: JSON.stringify({ iteration, finishReason }) }),
        onToolCall: (iteration, tool, args) =>
          stream.writeSSE({ event: "tool_call", data: JSON.stringify({ iteration, tool, args }) }),
        onToolResult: (tool, result) =>
          stream.writeSSE({ event: "tool_result", data: JSON.stringify({ tool, result }) }),
        onAnswerDelta: (delta) => stream.writeSSE({ event: "answer_delta", data: JSON.stringify({ delta }) }),
      };

      try {
        const result = await start(hooks);
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ runId, ...result }),
        });
      } catch (err) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ runId, error: describe(err) }) });
      } finally {
        runs.delete(runId);
      }
    });
  }

  try {
    const result = await start();
    return c.json({ runId, ...result });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) return c.json({ runId, error: "aborted" }, 499 as ContentfulStatusCode);
    return c.json({ runId, error: describe(err) }, 500);
  } finally {
    runs.delete(runId);
  }
});

app.delete("/api/runs/:id", (c) => {
  const ctrl = runs.get(c.req.param("id"));
  if (!ctrl) return c.json({ error: "run not found" }, 404);
  ctrl.abort();
  return c.json({ ok: true });
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    modelKey: Boolean(process.env.OPENAI_API_KEY),
    exaKey: Boolean(process.env.EXA_API_KEY),
  }),
);

app.route(
  "/docs",
  Scalar.serve({
    document: openApiDocument,
    pageTitle: "Minimal Agent API",
    title: "Minimal Agent API",
  }),
);

export default app;
