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

// Case-based model tiering: BASIC_MODEL handles every text-based call
// (document summary, scope proposals, chat) -- cheap, and plenty capable
// for extracting facts from already-extracted plain text. ADVANCED_MODEL
// is reserved for genuinely harder cases -- today, drawing/CAD vision
// analysis (drawing-summary-service.ts), which needs multimodal image
// understanding a cheap text model can't do at all, not just does worse.
export const BASIC_MODEL = process.env.OPENAI_MODEL_BASIC || "gpt-4o-mini";
export const ADVANCED_MODEL = process.env.OPENAI_MODEL_ADVANCED || "gpt-4o";

// Back-compat: an already-configured OPENAI_MODEL still wins for the basic
// tier, so an existing deployment doesn't silently change model on upgrade.
export const DEFAULT_MODEL = process.env.OPENAI_MODEL || BASIC_MODEL;

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
