import OpenAI from "openai";
import "dotenv/config";

// The provider is OpenAI-compatible, so only baseURL changes. Read from the
// environment so a deployment can point at Groq, OpenRouter, or anything else
// without a code change.
export const getClient = (): OpenAI =>
  new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "missing",
  });

export type Effort = "low" | "medium" | "high";

/** One entry in the public model list served by GET /api/models. */
export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  context: number;
  efforts: Effort[];
};

/**
 * Curated Groq catalogue. `context` is the provider's window in tokens and
 * `efforts` lists the reasoning levels the model accepts — clients use both to
 * build pickers without hardcoding them.
 */
export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-oss-20b", name: "gpt-oss-20b", provider: "Groq", context: 131072, efforts: ["low", "medium", "high"] },
  { id: "openai/gpt-oss-120b", name: "gpt-oss-120b", provider: "Groq", context: 131072, efforts: ["low", "medium", "high"] },
  { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b", provider: "Groq", context: 131072, efforts: [] },
];

export const DEFAULT_MODEL = MODELS[0]!.id;

export const isKnownModel = (id: string): boolean => MODELS.some((m) => m.id === id);