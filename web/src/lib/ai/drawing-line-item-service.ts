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
  DEFAULT_DRAWING_BATCH_SIZE,
  reasoningBudgetForBatch,
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
import { normalizeDescriptionForMatch } from "@/lib/ai/line-item-duplicate-service";
import type { DocumentSummary, CitedText } from "@/lib/ai/document-summary-service";

type DrawingLineItemFromAI = {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  category: ScopeCategory;
  pageNumber: number;
};

// A scope-summary fact (from this SAME document's own summarizeDrawing
// pass) the model could not map to any proposed item -- see
// Document.proposedLineItemGaps' own schema comment for the real gap
// this closes. reason is the model's own account of why, e.g. "covered
// under the general frame-fabrication line above" is legitimate; a weak
// or missing reason is itself a signal something was genuinely missed.
type DrawingLineItemGapFromAI = { text: string; pageNumber: number | null; reason: string | null };

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
      gaps: {
        type: "array",
        description:
          "Facts from the 'already identified in this document's summary' checklist (see system prompt) that aren't reflected in items above. Empty array if no checklist was provided, or every fact is accounted for.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", description: "The checklist fact, copied as given." },
            pageNumber: { type: ["integer", "null"] },
            reason: {
              type: ["string", "null"],
              description:
                "Why this fact isn't its own line item -- e.g. already covered under a broader item, a note rather than biddable scope. Null only if genuinely unclear why it was missed.",
            },
          },
          required: ["text", "pageNumber", "reason"],
        },
      },
    },
    required: ["items", "gaps"],
  },
} as const;

export const SYSTEM_PROMPT = `You are looking at pages of a fabrication/construction drawing or CAD export for an event/exhibit contractor. Propose a list of distinct, biddable line items a contractor would need to price to build what's shown -- the granularity a real pricing schedule would use (e.g. "Booth structure fabrication", "Countertop fabrication", "Rigging/truss installation"), grounded in what's actually labeled or dimensioned on the sheets, not a generic paraphrase of "a booth drawing."

Each page is given to you twice: first as its real extracted PDF text (when the export tool embedded one -- exact labels, dimensions, and callouts, character-for-character as printed), then as a rendered image of that same page. When real text is present for a page, treat it as the authoritative source for exact wording and numbers -- it can't be misread the way a visual scan can, and it's your best tool for catching every distinct component on a dense sheet rather than only the most visually prominent one. Use the image to see how those labels relate to what they're pointing at. A page whose text line says none was extracted has no text layer at all (an AutoCAD SHX-annotation table, or a scanned page) -- read the image alone for that one.

When reading dimensions directly off an image (no text layer for that page), read the actual punctuation printed rather than assuming a format: exhibit/booth CAD exports commonly use decimal-inch notation exclusively -- e.g. 39.06" means thirty-nine and six-hundredths of an INCH (a decimal point before the last two digits, not a feet mark) -- not the X'-Y" feet-and-inches format common in other construction drawings. Don't convert or reinterpret a decimal-inch number into feet-and-inches; copy the digits and punctuation exactly as they appear.

For each item:
- description: name the item at that same biddable granularity, but for a custom-fabricated item -- a built structure, graphic, finish, or design element made specifically for this job rather than an off-the-shelf catalog product or rental -- preserve the sheet's own specifying language inside the name: the exact material, finish, dimension, or design detail as labeled or called out (e.g. "single-sided Chinese birch," not a generic paraphrase like "plywood"). That original wording is often the actual spec a shop floor builds from, and a paraphrase can silently lose it. For a standard catalog/rental/labor item, a concise generic name is fine and preferred -- this only matters for items nothing off-the-shelf will satisfy.
- qty: the quantity actually dimensioned or labeled on the sheet if there is one (a count, square footage, linear footage, etc.). If nothing is stated, use 1 and set qtyIsExplicit to false -- 1 is a placeholder meaning "this item exists, quantity unknown," never a guess at a real number. A sheet or element titled for multiple named instances (e.g. "Left & Right Back Corner," "Left and Right Side Wall") IS an explicit quantity, even with no numeral printed -- that title is stating there are 2 of whatever the sheet shows, typically mirrored and identical apart from a logo or graphic. Propose qty 2 (or however many instances the title names) with qtyIsExplicit: true for those, not a bare qty 1 as if only one existed.
- qtyIsExplicit: true when that qty value is actually printed on the sheet, OR when it's the count of named instances in a "Left & Right"-style element title as described above -- both are things the sheet itself states, just not always as a numeral.

A wall or panel elevation is sometimes dimensioned as a sequence of individual segment widths along one dimension line (e.g. several consecutive callouts marching across the top of a wall), rather than one aggregate span for the whole wall -- each such segment is one physical panel. When you see this: group segments that share the exact same stated dimension into ONE item with qty equal to how many segments share it (qtyIsExplicit: true -- that count comes directly from the sheet's own repeated dimensions). A segment whose dimension doesn't match any other segment on that same elevation is its own distinct item, qty 1, qtyIsExplicit: true -- its size is genuinely stated, this isn't the "unknown quantity" placeholder case. Match on the exact printed value -- don't treat close-but-different numbers (e.g. 39.01" vs 39.06") as the same panel just because they're similar; a corner or return panel is often intentionally cut to a slightly different width on purpose, and merging them would misreport both the count and what's actually on the sheet. Don't collapse an entire dimensioned run into one generic "wall panel" item with no count either -- every segment is a real, priceable panel.
- unit: a sensible unit for this item (EA, SQFT, LF, HR, LOT) -- infer from context if the sheet doesn't state one.
- lineType: MATERIAL for goods/fabrication, LABOR for installation/labor-only work, FEE for flat fees/rentals/services.
- category: which section this item belongs to.
- pageNumber: the page number given in that page's "Page N" label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).

Only propose items that describe actual work or goods to be provided -- skip title blocks, revision notes, and general notes entirely. If a sheet has no concrete fabrication scope (e.g. it's purely a floor plan with no callouts), it can contribute nothing.

category must be exactly one of: ${SCOPE_CATEGORIES.join(", ")}. Pick the closest fit rather than inventing a new name -- use "Other" only when nothing on the list is a reasonable match.

Two categories are easy to misroute into a broader neighbor -- check these before defaulting elsewhere:
- Audio/Visual: any screen, monitor, LED video wall/tile, touch screen, or other AV equipment -- even though it's electrically powered, it belongs here, not Electrical & Lighting (reserve that one for house power, task/accent lighting, and electrical hookups that aren't themselves a display or AV device).
- Custom Build: a fixture built specifically to showcase or display a particular product (a product rail, a dedicated display stand or cabinet, a feature element) -- reserve Booth Structure & Walls for the booth's own walls, frame, and structural shell, not fixtures placed inside it that exist to show off a product.

You may also be given a checklist below labeled "Facts already identified in this document's summary" -- specific dimensions/materials/callouts a separate earlier pass over this SAME document already found. Cross-check your proposed items against every fact on that list: each one should either be clearly reflected in an item's description (directly, or as part of a broader item that covers it), or added to gaps with a real, specific reason it isn't its own biddable line -- never silently dropped. A weak or generic reason ("not important") is worse than an honest "missed on first pass, should be its own item" -- gaps is a genuine coverage check, not a formality to satisfy. If no checklist was provided below, return gaps: [].`;

// A group of consecutive whole pages sent to the model as one call --
// never splits a single page's own images/text across two batches, which
// keeps the page-local "Left & Right" convention and the per-elevation
// segment-grouping instruction (see SYSTEM_PROMPT) working exactly as they
// did before batching existed -- both are conventions that live within one
// sheet, never across sheets.
interface DrawingPageBatch {
  images: string[];
  pageTexts: string[];
  pageNumbers: number[];
}

export function chunkPagesIntoBatches(
  images: string[],
  pageTexts: string[],
  pageNumbers: number[],
  batchSize: number,
): DrawingPageBatch[] {
  const batches: DrawingPageBatch[] = [];
  for (let i = 0; i < images.length; i += batchSize) {
    batches.push({
      images: images.slice(i, i + batchSize),
      pageTexts: pageTexts.slice(i, i + batchSize),
      pageNumbers: pageNumbers.slice(i, i + batchSize),
    });
  }
  return batches;
}

// Scopes the "Facts already identified in this document's summary"
// checklist (see SYSTEM_PROMPT) down to just the facts relevant to one
// batch's own pages, instead of resending the whole document's checklist
// on every batch call -- a real token-spend lever now that one document
// makes N calls instead of 1. A fact with no pageNumber (the earlier
// summarizeDrawing pass couldn't attribute it to a specific page) is
// included in EVERY batch rather than dropped or arbitrarily assigned to
// one -- cheap (checklist facts are short one-liners, not images) and
// keeps gap-coverage complete for facts the earlier pass genuinely
// couldn't pin down.
export function filterChecklistForBatch(scopeChecklist: CitedText[], batchPageNumbers: number[]): CitedText[] {
  const pages = new Set(batchPageNumbers);
  return scopeChecklist.filter((fact) => fact.pageNumber === null || pages.has(fact.pageNumber));
}

// Narrow, adjacent-batch-boundary-only safety net -- NOT a general
// cross-batch dedup pass. Splitting a document into sequential batches
// introduces one real new risk plain single-call proposing never had: the
// SAME physical element straddling a batch boundary (its last labeled
// panel on one batch's final page, its mirror/continuation on the next
// batch's first page) getting proposed twice, once per batch, since
// neither call can see the other's page. Mirrors findExactDuplicates's own
// posture (line-item-duplicate-service.ts): only drops a boundary item
// when it matches EXACTLY ONE item on the other side of the boundary -- an
// ambiguous or absent match is left alone rather than guessed, the same
// "don't force it" rule that file already established for the unrelated
// proposed-vs-committed case. Two adjacent batches separated by an
// excluded blank page (see pageImages' blankPageNumbers) are deliberately
// NOT treated as touching -- a real gap sits between them, not a seam.
export function mergeAdjacentBatchDuplicates(
  itemsByBatch: DrawingLineItemFromAI[][],
  pageNumbersByBatch: number[][],
): { items: DrawingLineItemFromAI[]; droppedCount: number } {
  const kept = itemsByBatch.map((batch) => [...batch]);
  let droppedCount = 0;
  for (let i = 1; i < kept.length; i++) {
    const prevPages = pageNumbersByBatch[i - 1];
    const thisPages = pageNumbersByBatch[i];
    if (prevPages.length === 0 || thisPages.length === 0) continue;
    const prevLastPage = Math.max(...prevPages);
    const thisFirstPage = Math.min(...thisPages);
    if (thisFirstPage - prevLastPage > 1) continue; // a real gap, not a seam
    const prevBoundaryItems = kept[i - 1].filter((item) => item.pageNumber === prevLastPage);
    const thisBoundaryItems = kept[i].filter((item) => item.pageNumber === thisFirstPage);
    for (const candidate of thisBoundaryItems) {
      const key = normalizeDescriptionForMatch(candidate.description);
      if (!key) continue;
      const matches = prevBoundaryItems.filter((item) => normalizeDescriptionForMatch(item.description) === key);
      if (matches.length === 1) {
        kept[i] = kept[i].filter((item) => item !== candidate);
        droppedCount++;
      }
    }
  }
  return { items: kept.flat(), droppedCount };
}

// Explicitly triggered (the Propose button, or buildEstimateFromAllDocuments),
// never run automatically at Analyze time -- same posture scope-line-
// item-service.ts's own header comment establishes for the text path, so
// a routine Analyze click doesn't silently double every drawing's vision
// cost.
// opportunityId ownership check -- see scope-line-item-service.ts's
// proposeLineItemsFromScope for the full rationale (same pipeline, same
// cost-bearing-AI-call-plus-write-back shape).
//
// Sept 2026: internally batches the vision call per small group of pages
// instead of one call for the whole document (see chunkPagesIntoBatches
// above and DEFAULT_DRAWING_BATCH_SIZE's own comment for why). Still one
// fully-awaitable async function with the same signature as before
// batching existed -- callers (this function's own tests,
// estimate-synthesis-service.ts's buildEstimateFromAllDocuments, and the
// throwaway diagnostic scripts used to develop this feature) keep working
// unchanged; only proposeScopeItemsAction (import-actions.ts) now wraps
// this call in next/server's after() instead of awaiting it directly, so
// its caller can poll Document.lineItemProposalStatus/BatchIndex/BatchTotal
// for live progress instead of blocking on one long request. Every DB
// write inside the loop below touches ONLY those progress fields (and, on
// failure, status/error) -- proposedLineItems/Gaps/Matches are written
// exactly once, in the single final update after every batch succeeds, so
// a mid-run failure never leaves partial item data behind.
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

  // Real gap this closes (Sept 2026, FootJoy PGA 2027 -- see
  // Document.proposedLineItemGaps' own schema comment): summarizeDrawing
  // (Analyze) and this function are two fully independent AI calls that
  // both re-read the same pages cold, so nothing previously forced this
  // pass to account for every fact the summary pass already found.
  // Building the checklist from whatever extractedSummary is ALREADY on
  // this document row -- if Analyze hasn't run yet (or predates this
  // field), scopeSummary is undefined and the checklist is simply skipped
  // (SYSTEM_PROMPT's own instruction covers the no-checklist case).
  const existingSummary = document.extractedSummary as unknown as DocumentSummary | null;
  const scopeChecklist = existingSummary?.scopeSummary ?? [];

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
      data: {
        proposedLineItems: [] as unknown as Prisma.InputJsonValue,
        proposedLineItemGaps: null as unknown as Prisma.InputJsonValue,
        lineItemProposalStatus: "COMPLETE",
        lineItemProposalBatchIndex: 0,
        lineItemProposalBatchTotal: 0,
        lineItemProposalError: null,
      },
    });
  }

  const batchSize = Number(process.env.AI_DRAWING_BATCH_SIZE) || DEFAULT_DRAWING_BATCH_SIZE;
  const batches = chunkPagesIntoBatches(images, pageTexts, pageNumbers, batchSize);

  // First write of the run -- makes batchTotal (only knowable once
  // pageImages has actually run) visible to a poller immediately, and
  // makes this function self-sufficient for progress tracking regardless
  // of caller (a direct test/script call, or proposeScopeItemsAction's
  // after()-backgrounded call).
  await db.document.update({
    where: { id: documentId },
    data: {
      lineItemProposalStatus: "ANALYZING",
      lineItemProposalBatchIndex: 0,
      lineItemProposalBatchTotal: batches.length,
      lineItemProposalStartedAt: new Date(),
      lineItemProposalError: null,
    },
  });

  const itemsByBatch: DrawingLineItemFromAI[][] = [];
  const gapsByBatch: DrawingLineItemGapFromAI[][] = [];

  // Sequential, not parallel -- no concurrency limiter exists anywhere in
  // this codebase yet (confirmed against every other AI pipeline), and
  // running batches one at a time is what makes a coherent, real
  // elapsed-time-so-far estimate possible for the progress UI (see
  // line-item-proposal-progress.tsx).
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (i > 0) {
      await db.document.update({ where: { id: documentId }, data: { lineItemProposalBatchIndex: i } });
    }
    const batchChecklist = filterChecklistForBatch(scopeChecklist, batch.pageNumbers);

    try {
      const completion = await client.chat.completions.create(
        {
          model, // vision extraction -- same bar as summarizeDrawing, not the text path's tiered choice
          temperature: 0.2,
          // See drawing-ai-client.ts's own comment -- only relevant for an
          // OpenRouter-routed reasoning model, inert otherwise. Scaled to
          // this batch's own page count rather than the flat
          // whole-document DRAWING_REASONING_BUDGET.
          ...(viaOpenRouter ? (reasoningBudgetForBatch(batch.pageNumbers.length) as unknown as Record<string, unknown>) : {}),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Drawing: ${document.filename} -- batch ${i + 1} of ${batches.length} (${batch.images.length} page image${batch.images.length === 1 ? "" : "s"})`,
                },
                ...(batchChecklist.length > 0
                  ? [
                      {
                        type: "text" as const,
                        text: `Facts already identified in this document's summary (cross-check against these -- see system prompt):\n${batchChecklist
                          .map((fact, idx) => `${idx + 1}. [page ${fact.pageNumber ?? "?"}] ${fact.text}`)
                          .join("\n")}`,
                      },
                    ]
                  : []),
                ...buildPageContentParts(batch.images, batch.pageTexts, batch.pageNumbers),
              ],
            },
          ],
          response_format: { type: "json_schema", json_schema: DRAWING_LINE_ITEM_SCHEMA },
        },
        { timeout: DRAWING_REQUEST_TIMEOUT_MS },
      );

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
            ? `${model} returned an empty response (possibly exhausted its reasoning token budget) -- see reasoningBudgetForBatch in drawing-ai-client.ts.`
            : "OpenAI returned an empty response.",
        );
      }
      const parsed = JSON.parse(content) as { items: DrawingLineItemFromAI[]; gaps: DrawingLineItemGapFromAI[] };
      itemsByBatch.push(parsed.items);
      gapsByBatch.push(batchChecklist.length > 0 ? parsed.gaps : []);
    } catch (err) {
      // Deliberately does NOT touch proposedLineItems/Gaps/Matches -- any
      // prior successful run's data is left exactly as it was. Re-running
      // is cheap (click Propose again), so this is the simplest safe
      // default over building partial-result/resume machinery.
      const message = `Batch ${i + 1} of ${batches.length} (pages ${batch.pageNumbers.join(", ")}) failed: ${err instanceof Error ? err.message : String(err)}`;
      await db.document.update({
        where: { id: documentId },
        data: { lineItemProposalStatus: "FAILED", lineItemProposalError: message },
      });
      throw err;
    }
  }

  const { items: mergedRaw, droppedCount } = mergeAdjacentBatchDuplicates(
    itemsByBatch,
    batches.map((b) => b.pageNumbers),
  );
  if (droppedCount > 0) {
    console.warn(
      `[proposeLineItemsFromDrawing] document ${documentId}: dropped ${droppedCount} likely cross-batch-boundary duplicate(s).`,
    );
  }

  // estimateId inherits the document's own manual tag directly -- same
  // "a rendering package is always cleanly single-project" reasoning as
  // drawing-summary-service.ts's withEmptyQuote, no vision-based project
  // classification here. sourceQuote stays empty, same accepted trust
  // reduction as that file (no text layer to verify a quote against).
  const items: ProposedLineItem[] = mergedRaw.map((item) => ({
    ...item,
    sourceQuote: "",
    estimateId: document.estimateId ?? null,
  }));

  const matchesCache = await buildProposedLineItemMatchesCache(items, versionId, document.opportunityId, documentId, userId);

  // Explicitly null (not the model's own gaps: []) when no checklist
  // existed to check against -- distinguishes "nothing to report because
  // there was nothing to check" from "checked a real checklist and every
  // fact was accounted for," per Document.proposedLineItemGaps' own
  // schema comment. Doesn't trust the model to make this distinction on
  // its own even though the prompt asks for it.
  const gaps = scopeChecklist.length > 0 ? gapsByBatch.flat() : null;

  return db.document.update({
    where: { id: documentId },
    data: {
      proposedLineItems: items as unknown as Prisma.InputJsonValue,
      proposedLineItemGaps: gaps as unknown as Prisma.InputJsonValue,
      ...(matchesCache ? { proposedLineItemMatches: matchesCache as unknown as Prisma.InputJsonValue } : {}),
      lineItemProposalStatus: "COMPLETE",
      lineItemProposalBatchIndex: batches.length,
      lineItemProposalError: null,
    },
  });
}
