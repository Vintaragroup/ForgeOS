// Model selection for the drawing-vision pipeline (summarizeDrawing,
// proposeLineItemsFromDrawing) ONLY -- every other AI call in the app
// (BASIC_MODEL/ADVANCED_MODEL uses in document-summary-service.ts,
// scope-line-item-service.ts, scope-coverage-service.ts,
// vendor-match-ai-service.ts, line-item-duplicate-service.ts, chat, etc.)
// is untouched by this file and stays on OpenAI directly. This is a static
// per-pipeline override, not a general "pick the best model per call"
// router -- no such router exists in this app.
//
// Real, tested motivation (Full Swing / FootJoy sessions, Sept 2026):
// gpt-4o's CAD-drawing extraction was measurably inconsistent on a real
// 11-page design takeoff (8-18 proposed items across identical re-runs at
// the same temperature, one sheet's real detail landing at zero every
// single time). A/B'd against that exact file via
// scripts/test-drawing-extraction.ts: Claude Sonnet 4.5 via OpenRouter
// produced 53 well-grounded items with the missing sheet fully captured
// and the sheet's own specifying language preserved faithfully (e.g. "grain
// running horizontally", verbatim); Gemini 2.5 Pro produced 61 but drifted
// slightly on exact wording and cost marginally more. No evidence either
// model is better for any OTHER AI call in this app -- this override is
// scoped to exactly the one pipeline it was tested against.
//
// AI_DRAWING_MODEL unset (the default) -- everything behaves exactly as it
// did before this file existed: OpenAI direct, ADVANCED_MODEL (gpt-4o).
// AI_DRAWING_MODEL set to an OpenRouter model id (e.g.
// "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro") -- routes
// through OpenRouter instead, requires OPENROUTER_API_KEY.
import OpenAI from "openai";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let openRouterClient: OpenAI | null = null;

export function getDrawingAiClient(): { client: OpenAI; model: string; viaOpenRouter: boolean } {
  const overrideModel = process.env.AI_DRAWING_MODEL;
  if (!overrideModel) {
    return { client: getOpenAiClient(), model: ADVANCED_MODEL, viaOpenRouter: false };
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "AI_DRAWING_MODEL is set but OPENROUTER_API_KEY is not -- add it to route drawing extraction through OpenRouter.",
    );
  }
  if (!openRouterClient) {
    openRouterClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      // OpenRouter's own optional attribution headers -- not required for
      // requests to succeed, only for showing up in their public rankings.
      defaultHeaders: {
        "HTTP-Referer": "https://forge-os-green.vercel.app",
        "X-Title": "ForgeOS drawing extraction",
      },
    });
  }
  return { client: openRouterClient, model: overrideModel, viaOpenRouter: true };
}

// Generous, empirically-derived headroom (scripts/test-drawing-extraction.ts's
// own A/B testing), not a tuned minimum -- a real 11-page CAD takeoff used
// 7,654 of this 24,000 reasoning-token budget (32% utilization) after an
// earlier, smaller/absent budget silently truncated that same document's
// response to nothing: a paid call ($0.011) that returned zero usable
// content, not a quality failure but a token-budget one. Only attached
// when routed through OpenRouter -- gpt-4o direct isn't a reasoning model
// and this would just be dead weight on that path. Applied uniformly to
// whatever model AI_DRAWING_MODEL names (not every OpenRouter model is a
// reasoning model, but an unrecognized `reasoning` field is inert for one
// that isn't, so this doesn't need a per-model lookup table).
export const DRAWING_REASONING_BUDGET = {
  max_tokens: 32000,
  reasoning: { max_tokens: 24000 },
} as const;

// Real incident (Titleist FootJoy re-upload, Sept 2026): a drawing
// analysis call ran the full 300s to Vercel's own hard function-timeout
// ceiling and got killed mid-flight, with zero exception logged --
// confirmed via Vercel's runtime logs, not a guess. The document was left
// stuck at extractionStatus "PROCESSING" forever, since the code that
// would set it to FAILED (and log why) never got to run. Every real
// successful run measured this session took 60-100s, so a call that's
// still running at 3x that is not going to finish -- this timeout makes
// the request fail on ITS OWN terms, inside the 300s window, so the
// existing catch block actually gets to log the real cause and mark the
// document FAILED (visible on the SUPER_ADMIN dashboard) instead of the
// platform silently killing the whole function with no trace at all.
export const DRAWING_REQUEST_TIMEOUT_MS = 180_000;

// Shared by summarizeDrawing and proposeLineItemsFromDrawing -- interleaves
// each page's real extracted text (when pageImages found one) directly
// before that page's own image, rather than one block of text followed by
// one block of images, so the model never has to cross-reference which
// text belongs to which image itself. Confirmed live (FootJoy 2027 design
// takeoff) that these CAD exports often DO carry a full, accurate text
// layer despite looking purely visual -- see drawing-summary-service.ts's
// own header comment for the fuller rationale. A page with pageTexts[i]
// === "" (no text layer at all -- an AutoCAD SHX-annotation table, or a
// scanned page) still gets an explicit line saying so, so the model
// doesn't have to guess whether the omission means "nothing was there" or
// "extraction silently failed."
//
// pageNumbers is REQUIRED, not inferred from array position -- since
// pageImages can now exclude a blank/undecodable page mid-sequence (see
// blank-page-detection.ts), images[i] is no longer implicitly page i+1.
// Labeling each page with its true source page number keeps the model's
// own pageNumber citations correct even when earlier pages were skipped.
export function buildPageContentParts(
  images: string[],
  pageTexts: string[],
  pageNumbers: number[],
): ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] {
  return images.flatMap((url, i) => {
    const text = pageTexts[i];
    const n = pageNumbers[i];
    return [
      {
        type: "text" as const,
        text: text
          ? `Page ${n} extracted text (real PDF text layer, exact as printed -- treat as authoritative for exact wording/numbers):\n${text}`
          : `Page ${n}: no extracted text layer available for this page -- read the image below directly.`,
      },
      { type: "image_url" as const, image_url: { url } },
    ];
  });
}
