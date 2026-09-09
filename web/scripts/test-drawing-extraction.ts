// Standalone, read-only test harness for the drawing-line-item extraction
// pipeline (proposeLineItemsFromDrawing's core logic) -- runs the exact
// same pageImages rendering, system prompt, schema, and model against a
// local file, with no DB/Document/Opportunity involved. Use this to sanity-
// check a new CAD/design-takeoff PDF's extraction quality before trusting
// it on a live estimate: does it render every page (pageImages now reports
// totalPages so truncation is visible), and does the proposed item list
// look reasonably complete against the real sheets.
//
// Run with: npx tsx scripts/test-drawing-extraction.ts <path-to-drawing.pdf>
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pageImages } from "../src/lib/ai/drawing-summary-service";
import { ADVANCED_MODEL, getOpenAiClient } from "../src/lib/ai/openai-client";
import { SYSTEM_PROMPT } from "../src/lib/ai/drawing-line-item-service";
import { SCOPE_CATEGORIES } from "../src/lib/ai/scope-line-item-service";

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
  if (!filePath) {
    console.error("Usage: npx tsx scripts/test-drawing-extraction.ts <path-to-drawing.pdf>");
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

  const client = getOpenAiClient();
  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    temperature: 0.2,
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
