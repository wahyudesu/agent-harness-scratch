import { openTools, type ToolProvider } from "./1-tools.js";
import { createContext } from "./3-context.js";
import { combineGuardrails, maxIterations, type GuardrailFn } from "./4-guardrails.js";
import { runLoop, type Effort, type LoopHooks, type LoopResult } from "./5-loop.js";

export type VerifyResult = {
  passed: boolean;
  reason: string;
  /** If true, don't retry — the task cannot succeed. */
  fatal?: boolean;
};

export type HarnessResult = LoopResult & {
  task: string;
  model: string;
  attempts: number;
  verification: VerifyResult | null;
};

export type HarnessOptions = {
  /** Tool backend: a local Chromium browser or the Exa web API (default chromium). */
  provider?: ToolProvider;
  /** Custom system prompt. */
  systemPrompt?: string;
  /** Iteration cap per attempt (default 15). */
  maxIterations?: number;
  /** Post-run verification. Return passed:false to trigger a retry. */
  verify?: (result: LoopResult & { task: string; model: string }) => VerifyResult;
  /** Retry attempts when verification fails (default 1 = no retry). */
  maxAttempts?: number;
  /** Abort signal, forwarded to model calls. */
  signal?: AbortSignal;
  /** Reasoning effort for providers that support it (Groq gpt-oss). */
  effort?: Effort;
  /** Progress callbacks. Supplying `onAnswerDelta` switches the model call to streaming. */
  hooks?: LoopHooks;
};

// Run the agent loop with optional verify + retry.
// Each attempt gets a fresh browser session.
export async function runHarness(
  task: string,
  model: string,
  options: HarnessOptions = {},
): Promise<HarnessResult> {
  const maxAttempts = options.maxAttempts ?? 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runHarnessAttempt(task, model, options);
    const verification = options.verify ? options.verify(result) : null;
    // A failed verification replaces the answer, except when the loop stopped on
    // a guardrail: the model then answered from its gathered evidence, and
    // "no tool call" would discard a real answer. The reason still travels in
    // `stoppedBy` and `verification`.
    const answer =
      result.stoppedBy === "guardrail"
        ? result.answer
        : verification && !verification.passed
          ? verification.reason
          : result.answer;

    const final: HarnessResult = { ...result, answer, attempts: attempt, verification };

    // Retrying after a guardrail stop just burns another attempt on the same
    // failure, and the retry replaces the partial work with nothing.
    if (
      !verification ||
      verification.passed ||
      verification.fatal ||
      result.stoppedBy === "guardrail" ||
      attempt === maxAttempts
    ) {
      return final;
    }
    console.log(`[harness] attempt ${attempt} failed — retrying (${attempt + 1}/${maxAttempts})`);
  }

  throw new Error("harness finished without producing a result");
}

async function runHarnessAttempt(
  task: string,
  model: string,
  options: HarnessOptions,
): Promise<LoopResult & { task: string; model: string }> {
  const { session, registry } = await openTools(options.provider ?? "chromium");
  try {
    const messages = createContext(
      task,
      options.systemPrompt,
      registry.definitions.map((d) => d.function.name),
    );
    const guardrail: GuardrailFn = options.maxIterations
      ? combineGuardrails(maxIterations(options.maxIterations))
      : combineGuardrails();
    const result = await runLoop(
      model,
      messages,
      guardrail,
      registry,
      options.hooks ?? {},
      options.signal,
      options.effort,
    );
    return { task, model, ...result };
  } finally {
    await session.close();
  }
}
