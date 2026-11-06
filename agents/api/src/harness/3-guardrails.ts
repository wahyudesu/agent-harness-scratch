import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Everything a guardrail may read. A guardrail declares its needs by destructuring
// only what it uses; the loop always passes the full object.
export type GuardrailInput = { iterations: number; messages: ChatCompletionMessageParam[] };
export type GuardrailResult = { ok: true } | { ok: false; reason: string };
export type GuardrailFn = (input: GuardrailInput) => GuardrailResult;

// Guardrail: hard cap on loop iterations.
export function maxIterations(limit: number): GuardrailFn {
  return ({ iterations }) =>
    iterations >= limit
      ? { ok: false, reason: `Guardrail: reached iteration limit (${limit})` }
      : { ok: true };
}

// Guardrail: cap on context size (messages).
export function maxMessages(limit: number): GuardrailFn {
  return ({ messages }) =>
    messages.length > limit
      ? { ok: false, reason: `Guardrail: context too large (${messages.length} messages)` }
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
