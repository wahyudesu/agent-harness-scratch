import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { getClient } from "./2-model.js";
import { trimContext } from "./3-context.js";
import { defaultGuardrails, type GuardrailFn } from "./4-guardrails.js";
import type { ToolRegistry } from "./1-tools.js";

const MAX_CONTEXT_MESSAGES = 20;

// A single tool call + its result, captured for the trace
export type ToolEvent = {
  tool: string;
  args: Record<string, unknown>;
  result: string;
};

// One loop iteration: the model either called tools or gave a final answer
export type LoopIteration = {
  index: number;
  outcome: "tool_calls" | "answer";
  toolEvents: ToolEvent[];    // empty if outcome is "answer"
  contextSize: number;        // how many messages were in context for this call
  contextTrimmed: boolean;    // true if we dropped old messages before this call
};

export type StopReason = "model" | "guardrail" | "success";

import type { Effort } from "./2-model.js";
export type { Effort };

export type LoopResult = {
  answer: string;
  iterations: number;
  trace: LoopIteration[];
  stoppedBy: StopReason;
};

export type LoopHooks = {
  onModelCall?: (iteration: number, finishReason: string) => void;
  onToolCall?: (iteration: number, tool: string, args: Record<string, unknown>) => void;
  onToolResult?: (tool: string, result: string) => void;
  /** Answer tokens as they arrive. `final` marks the last chunk of the message. */
  onAnswerDelta?: (delta: string, final: boolean) => void;
  onAnswer?: (answer: string) => void;
};

export async function runLoop(
  model: string,
  messages: ChatCompletionMessageParam[],
  guardrail: GuardrailFn = defaultGuardrails,
  tools: ToolRegistry,           // injected by the harness, not imported globally
  hooks: LoopHooks = {},
  signal?: AbortSignal,
  effort?: Effort,
): Promise<LoopResult> {
  const trace: LoopIteration[] = [];
  const streaming = Boolean(hooks.onAnswerDelta);

  while (true) {
    signal?.throwIfAborted();

    const iterationIndex = trace.length + 1;

    // ── Context compression ───────────────────
    const beforeTrim = messages.length;
    messages = trimContext(messages, MAX_CONTEXT_MESSAGES);
    const contextTrimmed = messages.length < beforeTrim;

    // ── Guardrail check ───────────────────────
    const check = guardrail({ iterations: trace.length, messages });
    if (!check.ok) {
      // Out of room, but the model has already gathered the evidence: ask once
      // more with tools removed so it answers from what it has instead of the
      // run ending on a guardrail message.
      const finalMessages: ChatCompletionMessageParam[] = [
        ...messages,
        {
          role: "user",
          content: "You are out of tool budget. Answer the original task now using only what you already gathered. If something is unverified, say so.",
        },
      ];
      const final = await getClient().chat.completions.create(
        { model, messages: finalMessages, ...(effort ? { reasoning_effort: effort } : {}) },
        { signal },
      );
      const answer = final.choices[0]?.message.content ?? check.reason;
      hooks.onAnswer?.(answer);
      return { answer, iterations: trace.length, trace, stoppedBy: "guardrail" };
    }

    // ── Model call ────────────────────────────
    const request = {
      model,
      messages,
      tools: tools.definitions,
      ...(effort ? { reasoning_effort: effort } : {}),
    };

    if (streaming) {
      const stream = await getClient().chat.completions.create(
        { ...request, stream: true },
        { signal },
      );
      const choice = await collectStream(stream, (delta) => hooks.onAnswerDelta!(delta, false));
      const contextSize = messages.length;
      const droppedCalls = choice.message.tool_calls?.filter((call) => !call.id).length ?? 0;
      if (droppedCalls > 0) {
        // Never send a tool call back without an id: providers reject the whole
        // request, and the caller would see only a 400 with no context.
        throw new Error(
          `provider streamed ${droppedCalls} tool call(s) without an id; cannot continue the loop`,
        );
      }
      // A streamed message whose arguments are not JSON cannot be replayed: the
      // provider validates history on the next call and rejects the run with
      // 400 "Failed to parse tool call arguments as JSON". Drop that message and
      // ask again instead of poisoning the context.
      const malformed = (choice.message.tool_calls ?? []).filter((call) => {
        try {
          JSON.parse(call.function.arguments || "{}");
          return false;
        } catch {
          return true;
        }
      });
      if (malformed.length > 0) {
        const names = malformed.map((call) => call.function.name).join(", ");
        // The tool never ran; log and re-ask so the context stays valid.
        console.warn(`[loop] dropped malformed tool call arguments for ${names}; retrying`);
        continue;
      }
      hooks.onModelCall?.(iterationIndex, choice.finish_reason ?? "unknown");
      messages.push(choice.message as ChatCompletionMessageParam);
      if (choice.finish_reason === "stop") hooks.onAnswerDelta!("", true);

      if (choice.finish_reason === "stop") {
        trace.push({ index: iterationIndex, outcome: "answer", toolEvents: [], contextSize, contextTrimmed });
        const answer = (choice.message.content as string | null) ?? "(no response)";
        hooks.onAnswer?.(answer);
        return { answer, iterations: trace.length, trace, stoppedBy: "model" };
      }

      if (choice.finish_reason === "tool_calls") {
        await executeToolCalls(choice.message, iterationIndex, messages, tools, hooks, trace, {
          contextSize,
          contextTrimmed,
        });
      }
      continue;
    }

    const response = await getClient().chat.completions.create(request, { signal });
    const choice = response.choices[0];
    const contextSize = messages.length;
    hooks.onModelCall?.(iterationIndex, choice.finish_reason ?? "unknown");

    messages.push(choice.message as ChatCompletionMessageParam);

    // ── Final answer ──────────────────────────
    if (choice.finish_reason === "stop") {
      trace.push({ index: iterationIndex, outcome: "answer", toolEvents: [], contextSize, contextTrimmed });

      const answer = choice.message.content ?? "(no response)";
      hooks.onAnswer?.(answer);
      return { answer, iterations: trace.length, trace, stoppedBy: "model" };
    }

    // ── Tool calls → execute → loop ───────────
    if (choice.finish_reason === "tool_calls") {
      await executeToolCalls(choice.message, iterationIndex, messages, tools, hooks, trace, {
        contextSize,
        contextTrimmed,
      });
    }
  }
}

/** Execute every tool call in order and append each result to the context. */
async function executeToolCalls(
  message: ChatCompletionMessage,
  iterationIndex: number,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  hooks: LoopHooks,
  trace: LoopIteration[],
  meta: { contextSize: number; contextTrimmed: boolean },
): Promise<void> {
  const toolEvents: ToolEvent[] = [];

  for (const call of message.tool_calls ?? []) {
    const name = call.function.name;
    let args: Record<string, unknown> = {};
    let malformed: string | null = null;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // A stream can truncate arguments mid-JSON. Sending them back makes the
      // provider reject the next request outright, so answer the model instead.
      malformed = call.function.arguments.slice(0, 200);
    }

    const tool = tools.byName.get(name);
    hooks.onToolCall?.(iterationIndex, name, args);
    let result: string;
    try {
      result = malformed
        ? `Error: arguments for "${name}" were not valid JSON (${JSON.stringify(malformed)}). Call it again with complete arguments.`
        : // The model can invent names (e.g. "browser_search"); echoing the real
          // list back lets it recover on the next iteration instead of stalling.
          tool
          ? await tool.execute(args)
          : `Error: unknown tool "${name}". Use only: ${[...tools.byName.keys()].join(", ")}`;
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    hooks.onToolResult?.(name, result);

    toolEvents.push({ tool: name, args, result });
    messages.push({ role: "tool", tool_call_id: call.id, content: result });
  }

  trace.push({ index: iterationIndex, outcome: "tool_calls", toolEvents, ...meta });
}

/**
 * Reassemble one streamed completion: content deltas are forwarded as they
 * arrive, tool-call fragments are concatenated (the provider indexes them by
 * position, and `arguments` is split across arbitrary chunk boundaries).
 */
async function collectStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  onDelta: (delta: string) => void,
): Promise<ChatCompletion.Choice> {
  let content = "";
  let finishReason: ChatCompletion.Choice["finish_reason"] = "stop";
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta?.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    for (const part of delta?.tool_calls ?? []) {
      const slot = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.name += part.function.name;
      if (part.function?.arguments) slot.arguments += part.function.arguments;
      calls.set(part.index, slot);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  return {
    index: 0,
    finish_reason: finishReason,
    logprobs: null,
    message: {
      role: "assistant",
      content: content || null,
      // No `refusal` key: Groq rejects it when the message is sent back.
      tool_calls: [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, slot]) => ({
          id: slot.id,
          type: "function" as const,
          index,
          function: { name: slot.name, arguments: slot.arguments },
        })),
    },
    // The SDK type requires `refusal`; the wire format must not carry it.
  } as unknown as ChatCompletion.Choice;
}
