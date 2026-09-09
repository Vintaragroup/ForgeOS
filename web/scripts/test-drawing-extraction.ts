// Standalone, read-only test harness for the drawing-line-item extraction
// pipeline (proposeLineItemsFromDrawing's core logic) -- runs the exact
// same pageImages rendering, system prompt, and schema against a local
// file, with no DB/Document/Opportunity involved. Use this to sanity-check
// a new CAD/design-takeoff PDF's extraction quality before trusting it on a
// live estimate: does it render every page (pageImages now reports
// totalPages so truncation is visible), and does the proposed item list
// look reasonably complete against the real sheets.
//
// Also doubles as a model-comparison harness: pass a second argument to
// route the exact same prompt/schema/images through OpenRouter instead of
// OpenAI directly, so a different vision model's extraction quality can be
// A/B'd against the real pipeline's own output with zero risk to
// proposeLineItemsFromDrawing itself (this script never touches it). Real
// motivation: FootJoy 2027's design takeoff showed real run-to-run
// inconsistency out of gpt-4o at temperature 0.2 (13-18 items across
// identical re-runs, one sheet's real detail dropped to zero every time) --
// worth knowing whether that's model-specific before spending more effort
// on prompt tuning against a single provider.
//
// Run with:
//   npx tsx scripts/test-drawing-extraction.ts <path-to-drawing.pdf>
//   npx tsx scripts/test-drawing-extraction.ts <path-to-drawing.pdf> <openrouter-model-id>
// The second form needs OPENROUTER_API_KEY set (openrouter.ai/keys) --
// model IDs look like "google/gemini-2.5-pro" or "anthropic/claude-sonnet-4.5",
// see openrouter.ai/models for the full list and per-model pricing.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { pageImages } from "../src/lib/ai/drawing-summary-service";
import { ADVANCED_MODEL, getOpenAiClient } from "../src/lib/ai/openai-client";
import { SYSTEM_PROMPT } from "../src/lib/ai/drawing-line-item-service";
import { SCOPE_CATEGORIES } from "../src/lib/ai/scope-line-item-service";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function resolveClientAndModel(openRouterModelId: string | undefined): { client: OpenAI; model: string; provider: string } {
  if (!openRouterModelId) {
    return { client: getOpenAiClient(), model: ADVANCED_MODEL, provider: "openai" };
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set -- add it to .env to use an OpenRouter model id.");
  }
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
    // OpenRouter's own optional attribution headers -- not required for
    // requests to succeed, only for showing up in their public rankings.
    defaultHeaders: {
      "HTTP-Referer": "https://forge-os-green.vercel.app",
      "X-Title": "ForgeOS drawing-extraction test",
    },
  });
  return { client, model: openRouterModelId, provider: "openrouter" };
}

const DRAWING_LINE_ITEM_SCHEMA = {
  name: "drawing_line_items",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: { type: "string" },
            qty: { type: "number" },
            qtyIsExplicit: { type: "boolean" },
            unit: { type: "string" },
            lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"] },
            category: { type: "string", enum: SCOPE_CATEGORIES },
            pageNumber: { type: "integer" },
          },
          required: ["description", "qty", "qtyIsExplicit", "unit", "lineType", "category", "pageNumber"],
        },
      },
    },
    required: ["items"],
  },
} as const;

type DrawingLineItemResult = {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  category: string;
  pageNumber: number;
};

const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

async function main() {
  const filePath = process.argv[2];
  const openRouterModelId = process.argv[3];
  if (!filePath) {
    console.error("Usage: npx tsx scripts/test-drawing-extraction.ts <path-to-drawing.pdf> [openrouter-model-id]");
    process.exit(1);
  }

  const mimeType = EXT_TO_MIME[path.extname(filePath).toLowerCase()];
  if (!mimeType) {
    console.error(`Unrecognized extension "${path.extname(filePath)}" -- expected one of: ${Object.keys(EXT_TO_MIME).join(", ")}`);
    process.exit(1);
  }

  const bytes = await readFile(filePath);
  console.log(`Loaded ${bytes.length} bytes from ${path.basename(filePath)}.`);

  const { images, totalPages } = await pageImages(mimeType, bytes);
  console.log(`Rendered ${images.length} of ${totalPages} page image(s).`);
  if (totalPages > images.length) {
    console.log(`WARNING: ${totalPages - images.length} page(s) truncated by MAX_DRAWING_PAGES -- set AI_DRAWING_MAX_PAGES higher to include them.`);
  }
  if (images.length === 0) {
    console.log("Nothing to analyze -- exiting.");
    return;
  }

  const { client, model, provider } = resolveClientAndModel(openRouterModelId);
  console.log(`Using ${provider}:${model}.`);
  // Reasoning-model budget -- a real gap found live: Gemini 2.5 Pro via
  // OpenRouter burned 5,435 reasoning tokens on just 2 page images before
  // ever writing the JSON content. With no explicit budget, the full
  // 11-page FootJoy run exhausted its token allowance mid-reasoning and
  // returned completely empty content -- a paid call ($0.011) with nothing
  // usable, not a quality problem but a silent truncation one. max_tokens
  // and reasoning.max_tokens are both generous headroom (scaled off that
  // 2-page measurement for ~11 pages of real visual density), not tuned
  // minimums -- OpenAI's own SDK types don't know about OpenRouter's
  // reasoning field, hence the cast; a non-reasoning model (gpt-4o) simply
  // ignores it.
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 32000,
    ...(provider === "openrouter" ? ({ reasoning: { max_tokens: 24000 } } as Record<string, unknown>) : {}),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Drawing: ${path.basename(filePath)} (${images.length} page images)` },
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: DRAWING_LINE_ITEM_SCHEMA },
  });

  console.log("Usage:", completion.usage);
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { items: DrawingLineItemResult[] };
  console.log(`\nProposed ${parsed.items.length} line items:\n`);
  for (const item of parsed.items) {
    console.log(
      `  [pg${item.pageNumber}] ${item.lineType} x${item.qty}${item.qtyIsExplicit ? "" : "(inferred)"} ${item.unit} -- "${item.description}" [${item.category}]`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
