// Sibling to scope-line-item-service.ts the same way drawing-summary-
// service.ts is a sibling to document-summary-service.ts -- a genuinely
// different input pipeline (vision page images, not extracted text), not
// a variant of the text-based proposer. Closes a real gap: DRAWING
// documents were excluded from every line-item path (see
// estimate-synthesis-service.ts's old DRAWING exclusion) because
// proposeLineItemsFromScope requires document.extractedText, which a
// drawing never has -- so renderings, the most reliably single-project-
// tagged documents in a real RFP package, contributed zero line items no
// matter what.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { pageImages } from "@/lib/ai/drawing-summary-service";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { SCOPE_CATEGORIES, type ProposedLineItem, type ScopeCategory } from "@/lib/ai/scope-line-item-service";

type DrawingLineItemFromAI = {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  category: ScopeCategory;
  pageNumber: number;
};

// No quote field requested from the model at all -- same accepted
// trust-reduction precedent as drawing-summary-service.ts's own schema
// (scopeSummary/riskFlags there have no quote either): there's no
// extracted-text layer to verify a "quote" against, so asking for one
// would just invite a fabricated-looking string. pageNumber is model-
// reported and trusted directly, same as that file's keyDates/scopeSummary.
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
            qtyIsExplicit: {
              type: "boolean",
              description: "True only when qty was actually dimensioned/labeled on the sheet, not inferred or guessed.",
            },
            unit: { type: "string", description: "A sensible unit for this item -- EA, SQFT, LF, HR, LOT, etc." },
            lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"] },
            category: { type: "string", enum: SCOPE_CATEGORIES },
            pageNumber: {
              type: "integer",
              description: "1-indexed position of the image (in the order provided) where this item was seen.",
            },
          },
          required: ["description", "qty", "qtyIsExplicit", "unit", "lineType", "category", "pageNumber"],
        },
      },
    },
    required: ["items"],
  },
} as const;

const SYSTEM_PROMPT = `You are looking at page images of a fabrication/construction drawing or CAD export for an event/exhibit contractor. Propose a list of distinct, biddable line items a contractor would need to price to build what's shown -- the granularity a real pricing schedule would use (e.g. "Booth structure fabrication", "Countertop fabrication", "Rigging/truss installation"), grounded in what's actually labeled or dimensioned on the sheets, not a generic paraphrase of "a booth drawing."

For each item:
- qty: the quantity actually dimensioned or labeled on the sheet if there is one (a count, square footage, linear footage, etc.). If nothing is stated, use 1 and set qtyIsExplicit to false -- 1 is a placeholder meaning "this item exists, quantity unknown," never a guess at a real number.
- qtyIsExplicit: true ONLY when that qty value is actually printed on the sheet.
- unit: a sensible unit for this item (EA, SQFT, LF, HR, LOT) -- infer from context if the sheet doesn't state one.
- lineType: MATERIAL for goods/fabrication, LABOR for installation/labor-only work, FEE for flat fees/rentals/services.
- category: which section this item belongs to.
- pageNumber: the 1-indexed position of the image (in the order provided) where you saw it -- your actual position in the list you were given, not a guess.

Only propose items that describe actual work or goods to be provided -- skip title blocks, revision notes, and general notes entirely. If a sheet has no concrete fabrication scope (e.g. it's purely a floor plan with no callouts), it can contribute nothing.

category must be exactly one of: ${SCOPE_CATEGORIES.join(", ")}. Pick the closest fit rather than inventing a new name -- use "Other" only when nothing on the list is a reasonable match.`;

// Explicitly triggered (the Propose button, or buildEstimateFromAllDocuments),
// never run automatically at Analyze time -- same posture scope-line-
// item-service.ts's own header comment establishes for the text path, so
// a routine Analyze click doesn't silently double every drawing's vision
// cost.
export async function proposeLineItemsFromDrawing(documentId: string, userId: string | null = null) {
  const { document, bytes } = await getDocumentBytes(documentId);

  // Throws AiNotConfiguredError before any DB write, same posture as
  // proposeLineItemsFromScope.
  const client = getOpenAiClient();

  const images = await pageImages(document.mimeType, bytes);
  if (images.length === 0) {
    // A genuinely empty PDF -- nothing to propose, and re-running won't
    // change that. Same "real, not a failure" posture as
    // summarizeDrawing's UNSUPPORTED branch, but propose has no separate
    // status field to flip -- an empty cached proposal is itself the
    // correct signal (matches commitScopeLineItems's "click Propose
    // items first" guard for a genuinely never-proposed document only
    // when the cache is still null, not an empty array).
    return db.document.update({
      where: { id: documentId },
      data: { proposedLineItems: [] as unknown as Prisma.InputJsonValue },
    });
  }

  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL, // vision extraction -- same bar as summarizeDrawing, not the text path's tiered choice
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Drawing: ${document.filename} (${images.length} page image${images.length === 1 ? "" : "s"})`,
          },
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: DRAWING_LINE_ITEM_SCHEMA },
  });

  await recordAiUsage({
    userId,
    feature: "DRAWING_LINE_ITEMS",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    documentId,
    opportunityId: document.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { items: DrawingLineItemFromAI[] };

  // estimateId inherits the document's own manual tag directly -- same
  // "a rendering package is always cleanly single-project" reasoning as
  // drawing-summary-service.ts's withEmptyQuote, no vision-based project
  // classification here. sourceQuote stays empty, same accepted trust
  // reduction as that file (no text layer to verify a quote against).
  const items: ProposedLineItem[] = parsed.items.map((item) => ({
    ...item,
    sourceQuote: "",
    estimateId: document.estimateId ?? null,
  }));

  return db.document.update({
    where: { id: documentId },
    data: { proposedLineItems: items as unknown as Prisma.InputJsonValue },
  });
}
