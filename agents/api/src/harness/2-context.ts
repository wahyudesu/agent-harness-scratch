import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const SYSTEM_PROMPT = `
You are a helpful assistant with access to tools.
Use tools whenever they help you give a more accurate answer.
When you have enough information, respond directly and concisely.
`.trim();

// Build the initial context for a new task.
// The tool list is appended to whichever system prompt is in use — including a
// caller-supplied one. Without it the model hallucinates tools that are not in
// the request (e.g. "browser_search"), which some providers reject with 400
// before our loop can react.
export function createContext(
  task: string,
  systemPrompt?: string,
  toolNames?: string[],
): ChatCompletionMessageParam[] {
  const availableTools = toolNames?.length
    ? `\n\nYou have EXACTLY these tools — never call any tool not in this list. If you need a capability none of them provide, say so in your answer instead of inventing a tool:\n${toolNames.map((n) => `- ${n}`).join("\n")}`
    : "";
  return [
    { role: "system", content: (systemPrompt ?? SYSTEM_PROMPT) + availableTools },
    { role: "user", content: task },
  ];
}

// Drop old tool messages if context grows too large.
// Always keep the system prompt and original user task.
export function trimContext(
  messages: ChatCompletionMessageParam[],
  maxMessages: number,
): ChatCompletionMessageParam[] {
  if (messages.length <= maxMessages) return messages;

  const [system, user] = messages;
  const rest = messages.slice(2);
  const trimmed = rest.slice(rest.length - (maxMessages - 2));
  return [system, user, ...trimmed];
}
