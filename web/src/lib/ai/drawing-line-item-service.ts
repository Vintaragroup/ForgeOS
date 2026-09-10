// Sibling to scope-line-item-service.ts the same way drawing-summary-
// service.ts is a sibling to document-summary-service.ts -- a genuinely
// different input pipeline (vision page images, plus each page's own
// extracted text when pageImages finds one -- see that file's header
// comment), not a variant of the text-based proposer. Document.extractedText
// itself is still never populated for a DRAWING (that field is
// document-summary-service.ts's own stored, merged-across-pages text, a
// different thing from pageImages' fresh per-request per-page text), so
// this stays its own pipeline. Closes a real gap: DRAWING documents were
// excluded from every line-item path (see estimate-synthesis-service.ts's
// old DRAWING exclusion) because proposeLineItemsFromScope requires
// Document.extractedText -- so renderings, the most reliably
// single-project-tagged documents in a real RFP package, contributed zero
// line items no matter what.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { pageImages } from "@/lib/ai/drawing-summary-service";
import {
  getDrawingAiClient,
  DRAWING_REASONING_BUDGET,
  DRAWING_REQUEST_TIMEOUT_MS,
  buildPageContentParts,
} from "@/lib/ai/drawing-ai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import {
  buildProposedLineItemMatchesCache,
  SCOPE_CATEGORIES,
  type ProposedLineItem,
  type ScopeCategory,
} from "@/lib/ai/scope-line-item-service";

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
// (scopeSummary/riskFlags there have no quote either): a per-page text
// block is now given to the model (see buildPageContentParts), but nothing
// here re-verifies a claimed quote against it the way
// document-summary-service.ts's locateQuotePage does for a real text
// document, so asking for one would still just invite a fabricated-looking
// string. pageNumber is model-reported and trusted directly, same as that
// file's keyDates/scopeSummary.
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
              description:
                "True when qty was actually dimensioned/labeled on the sheet, or when it's the count of named instances in a \"Left & Right\"-style element title (see system prompt) -- false when genuinely inferred or guessed.",
            },
            unit: { type: "string", description: "A sensible unit for this item -- EA, SQFT, LF, HR, LOT, etc." },
            lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"] },
            category: { type: "string", enum: SCOPE_CATEGORIES },
            pageNumber: {
              type: "integer",
              description:
                "The page number given in that page's 'Page N' label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).",
            },
          },
          required: ["description", "qty", "qtyIsExplicit", "unit", "lineType", "category", "pageNumber"],
        },
      },
    },
    required: ["items"],
  },
} as const;

export const SYSTEM_PROMPT = `You are looking at pages of a fabrication/construction drawing or CAD export for an event/exhibit contractor. Propose a list of distinct, biddable line items a contractor would need to price to build what's shown -- the granularity a real pricing schedule would use (e.g. "Booth structure fabrication", "Countertop fabrication", "Rigging/truss installation"), grounded in what's actually labeled or dimensioned on the sheets, not a generic paraphrase of "a booth drawing."

Each page is given to you twice: first as its real extracted PDF text (when the export tool embedded one -- exact labels, dimensions, and callouts, character-for-character as printed), then as a rendered image of that same page. When real text is present for a page, treat it as the authoritative source for exact wording and numbers -- it can't be misread the way a visual scan can, and it's your best tool for catching every distinct component on a dense sheet rather than only the most visually prominent one. Use the image to see how those labels relate to what they're pointing at. A page whose text line says none was extracted has no text layer at all (an AutoCAD SHX-annotation table, or a scanned page) -- read the image alone for that one.

For each item:
- description: name the item at that same biddable granularity, but for a custom-fabricated item -- a built structure, graphic, finish, or design element made specifically for this job rather than an off-the-shelf catalog product or rental -- preserve the sheet's own specifying language inside the name: the exact material, finish, dimension, or design detail as labeled or called out (e.g. "single-sided Chinese birch," not a generic paraphrase like "plywood"). That original wording is often the actual spec a shop floor builds from, and a paraphrase can silently lose it. For a standard catalog/rental/labor item, a concise generic name is fine and preferred -- this only matters for items nothing off-the-shelf will satisfy.
- qty: the quantity actually dimensioned or labeled on the sheet if there is one (a count, square footage, linear footage, etc.). If nothing is stated, use 1 and set qtyIsExplicit to false -- 1 is a placeholder meaning "this item exists, quantity unknown," never a guess at a real number. A sheet or element titled for multiple named instances (e.g. "Left & Right Back Corner," "Left and Right Side Wall") IS an explicit quantity, even with no numeral printed -- that title is stating there are 2 of whatever the sheet shows, typically mirrored and identical apart from a logo or graphic. Propose qty 2 (or however many instances the title names) with qtyIsExplicit: true for those, not a bare qty 1 as if only one existed.
- qtyIsExplicit: true when that qty value is actually printed on the sheet, OR when it's the count of named instances in a "Left & Right"-style element title as described above -- both are things the sheet itself states, just not always as a numeral.
- unit: a sensible unit for this item (EA, SQFT, LF, HR, LOT) -- infer from context if the sheet doesn't state one.
- lineType: MATERIAL for goods/fabrication, LABOR for installation/labor-only work, FEE for flat fees/rentals/services.
- category: which section this item belongs to.
- pageNumber: the page number given in that page's "Page N" label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).

Only propose items that describe actual work or goods to be provided -- skip title blocks, revision notes, and general notes entirely. If a sheet has no concrete fabrication scope (e.g. it's purely a floor plan with no callouts), it can contribute nothing.

category must be exactly one of: ${SCOPE_CATEGORIES.join(", ")}. Pick the closest fit rather than inventing a new name -- use "Other" only when nothing on the list is a reasonable match.

Two categories are easy to misroute into a broader neighbor -- check these before defaulting elsewhere:
- Audio/Visual: any screen, monitor, LED video wall/tile, touch screen, or other AV equipment -- even though it's electrically powered, it belongs here, not Electrical & Lighting (reserve that one for house power, task/accent lighting, and electrical hookups that aren't themselves a display or AV device).
- Custom Build: a fixture built specifically to showcase or display a particular product (a product rail, a dedicated display stand or cabinet, a feature element) -- reserve Booth Structure & Walls for the booth's own walls, frame, and structural shell, not fixtures placed inside it that exist to show off a product.`;

// Explicitly triggered (the Propose button, or buildEstimateFromAllDocuments),
// never run automatically at Analyze time -- same posture scope-line-
// item-service.ts's own header comment establishes for the text path, so
// a routine Analyze click doesn't silently double every drawing's vision
// cost.
// opportunityId ownership check -- see scope-line-item-service.ts's
// proposeLineItemsFromScope for the full rationale (same pipeline, same
// cost-bearing-AI-call-plus-write-back shape).
export async function proposeLineItemsFromDrawing(
  documentId: string,
  opportunityId: string,
  userId: string | null = null,
  // See proposeLineItemsFromScope's own identical parameter comment --
  // this shares commitScopeLineItems as its commit function, so the same
  // Tier 2 caching applies here too.
  versionId: string | null = null,
) {
  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  // Throws before any DB write, same posture as proposeLineItemsFromScope.
  // See drawing-ai-client.ts's own header for why this can be OpenRouter
  // instead of OpenAI direct -- scoped to this pipeline only.
  const { client, model, viaOpenRouter } = getDrawingAiClient();

  const { images, totalPages, pageTexts, pageNumbers, blankPageNumbers } = await pageImages(document.mimeType, bytes);
  const attempted = images.length + blankPageNumbers.length;
  if (totalPages > attempted) {
    // No schema/UI channel to surface this to the estimator reviewing the
    // proposed items yet (unlike summarizeDrawing's riskFlags, which
    // already reaches ProjectBriefCard for free) -- at minimum this makes
    // the truncation visible in server logs instead of purely silent.
    // attempted (not images.length) is the right comparand now that blank
    // pages are excluded from images -- see drawing-summary-service.ts's
    // pageImages for why.
    console.warn(
      `[proposeLineItemsFromDrawing] document ${documentId}: only analyzed ${attempted} of ${totalPages} pages (AI_DRAWING_MAX_PAGES limit).`,
    );
  }
  if (blankPageNumbers.length > 0) {
    // Real incident (Titleist "Concept V1E" upload, Sept 2026) -- see
    // isBlankPageImage's own header. Same "log only" posture as the
    // truncation warning above, not a new schema field.
    console.warn(
      `[proposeLineItemsFromDrawing] document ${documentId}: page(s) ${blankPageNumbers.join(", ")} rendered blank (likely an undecodable embedded image, e.g. JPEG2000) -- excluded from analysis.`,
    );
  }
  if (images.length === 0) {
    // A genuinely empty PDF, or every page rendered blank -- nothing to
    // propose, and re-running won't change that. Same "real, not a
    // failure" posture as summarizeDrawing's UNSUPPORTED branch, but
    // propose has no separate status field to flip -- an empty cached
    // proposal is itself the correct signal (matches commitScopeLineItems's
    // "click Propose items first" guard for a genuinely never-proposed
    // document only when the cache is still null, not an empty array).
    return db.document.update({
      where: { id: documentId },
      data: { proposedLineItems: [] as unknown as Prisma.InputJsonValue },
    });
  }

  const completion = await client.chat.completions.create({
    model, // vision extraction -- same bar as summarizeDrawing, not the text path's tiered choice
    temperature: 0.2,
    // See drawing-ai-client.ts's own comment -- only relevant for an
    // OpenRouter-routed reasoning model, inert otherwise.
    ...(viaOpenRouter ? (DRAWING_REASONING_BUDGET as unknown as Record<string, unknown>) : {}),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Drawing: ${document.filename} (${images.length} page image${images.length === 1 ? "" : "s"})`,
          },
          ...buildPageContentParts(images, pageTexts, pageNumbers),
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: DRAWING_LINE_ITEM_SCHEMA },
  }, { timeout: DRAWING_REQUEST_TIMEOUT_MS });

  await recordAiUsage({
    userId,
    feature: "DRAWING_LINE_ITEMS",
    model,
    usage: completion.usage,
    documentId,
    opportunityId: document.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    // A reasoning model can burn its whole token budget on internal
    // reasoning and never reach the actual JSON -- a real failure mode
    // confirmed live via OpenRouter (see DRAWING_REASONING_BUDGET), not
    // hypothetical.
    throw new Error(
      viaOpenRouter
        ? `${model} returned an empty response (possibly exhausted its reasoning token budget) -- see DRAWING_REASONING_BUDGET in drawing-ai-client.ts.`
        : "OpenAI returned an empty response.",
    );
  }
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

  const matchesCache = await buildProposedLineItemMatchesCache(items, versionId, document.opportunityId, documentId, userId);

  return db.document.update({
    where: { id: documentId },
    data: {
      proposedLineItems: items as unknown as Prisma.InputJsonValue,
      ...(matchesCache ? { proposedLineItemMatches: matchesCache as unknown as Prisma.InputJsonValue } : {}),
    },
  });
}
