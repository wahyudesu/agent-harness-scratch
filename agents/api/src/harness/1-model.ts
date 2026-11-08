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

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** One entry in the public model list served by GET /api/models. */
export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  efforts: readonly Effort[];
};

export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-oss-20b", name: "gpt-oss-20b", provider: "Groq", efforts: EFFORTS },
  { id: "openai/gpt-oss-120b", name: "gpt-oss-120b", provider: "Groq", efforts: EFFORTS },
  { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b", provider: "Groq", efforts: [] },
];

export const DEFAULT_MODEL = MODELS[0]!.id;

export const isKnownModel = (id: string): boolean => MODELS.some((m) => m.id === id);
