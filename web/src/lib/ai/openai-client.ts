import OpenAI from "openai";

// Single construction point, same reasoning as src/lib/db.ts's Prisma
// client -- model name/params configured once here, not scattered across
// call sites. Chat Completions (not the Responses API) throughout Phase
// 7: this app manages its own conversation state in Postgres already
// (ChatMessage rows), so a stateless completion call fits the existing
// "no external session state" architecture better than the Responses
// API's server-side threads would.

export class AiNotConfiguredError extends Error {
  constructor() {
    super("OPENAI_API_KEY is not set. AI features are unavailable until it's configured.");
    this.name = "AiNotConfiguredError";
  }
}

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

let client: OpenAI | null = null;

export function getOpenAiClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new AiNotConfiguredError();
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export function isAiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
