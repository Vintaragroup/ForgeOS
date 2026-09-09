// The AI FALLBACK for a pricing spreadsheet neither of pricing-import-
// service.ts's deterministic detectors (findDesignCostEstimateSheet,
// findPricingSheet) recognize -- confirmed necessary against two more
// real vendor formats in one real job (Full Swing PGA Orlando) that
// don't match either: a package-level AV/lighting bid (Fuse Technical
// Group, pricing only at a package subtotal, not per component) and a
// 33-sheet-per-component internal fabrication estimate. Tried LAST, only
// when both deterministic shapes fail -- deterministic parsing is always
// preferred where a shape is actually known (see those two files' own
// header comments); this exists so an unrecognized format doesn't dead-
// end an estimate instead of the user waiting on a hand-written parser
// for every new vendor's spreadsheet convention.

import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { addLineItemsBulk, addOption, findOrCreateSection } from "@/lib/estimate-service";
import { getDocumentBytes } from "@/lib/document-service";
import { serializeWorkbookForPrompt } from "@/lib/xlsx-utils";
import { resolveLineItemCategory } from "@/lib/line-item-category";
import { loadDuplicateCandidates, QTY_ESTIMATED_SUFFIX } from "@/lib/ai/scope-line-item-service";
import {
  findExactDuplicates,
  matchProposedLineItemsAgainstExisting,
  type LineItemDuplicateMatch,
  type ProposedItemForDuplicateCheck,
} from "@/lib/ai/line-item-duplicate-service";

export interface ProposedSpreadsheetLineItem {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  unitCost: number;
  // True only when THIS row has its own real price in the sheet -- false
  // for a package/group's component rows where only the package's own
  // subtotal is a real number (the Fuse bid's exact shape: a banner row
  // like "LED Circular Header -- 30' Diameter x 5'h" carries the real
  // $31,360, the individual tile/case/bar rows underneath it don't each
  // have their own price). A false here is the signal a reviewer needs
  // to know this number was reconstructed/estimated, not read directly.
  unitCostIsExplicit: boolean;
  category: string;
  sourceQuote: string;
  sheetName: string;
  // Set ONLY when the sheet itself has real textual evidence this row's
  // sheet is one of several mutually-exclusive alternatives for the same
  // scope -- an explicit comparison sheet, "Option A/B" language, "the
  // only difference is..." framing. Never inferred from ambiguity alone.
  // Confirmed necessary live: a real Fuse Technical Group bid had "Video
  // V1" (LED ceiling) and "Video V2" (projection ceiling) -- the client
  // picks ONE -- both committed as regular line items would silently
  // double the real cost. Rows that are genuinely alternatives to each
  // other share the same label (e.g. "Video Package: LED Ceiling vs
  // Projection Ceiling"); every other row (the overwhelming majority)
  // gets null. This never auto-splits anything by itself -- see
  // findAlternateGroups and commitAiProposedImport's sheetDestinations
  // param, which require a human's own choice before anything commits to
  // a different destination than the base version.
  alternateGroupLabel?: string | null;
}

const SOURCE_QUOTE_DESCRIPTION =
  "The row's own distinguishing cell text, copied EXACTLY as it appears in the sheet data above -- never paraphrased. This is how a reviewer's click jumps back to the right cell, so it must be a real, exact substring of what you were given.";

// categories is the live catalog (db.category.findMany), not a fixed
// list -- same reason buildProposalSchema in scope-line-item-service.ts
// takes projectNames dynamically: the category taxonomy is a real,
// user-editable DB table (line-item-category.ts's own header comment on
// why it moved off a hardcoded constant), so the schema has to be built
// per-call against whatever it currently is.
export function buildSpreadsheetProposalSchema(categoryNames: string[]) {
  return {
    name: "spreadsheet_line_items",
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
                description: "True only when this exact quantity is a real number in the sheet, not a placeholder.",
              },
              unit: { type: "string", description: "A sensible unit -- EA, SQFT, LF, HR, LOT, etc." },
              unitCost: { type: "number" },
              unitCostIsExplicit: {
                type: "boolean",
                description:
                  "True only when THIS row has its own real price in the sheet. If pricing only exists at a package/group level (one subtotal covering several component rows), propose ONE line item for the whole package using that real subtotal as unitCost with qty 1 and unitCostIsExplicit true -- never split a package price across its components or invent a per-component number.",
              },
              category: {
                type: "string",
                description: `A category for this item. Use exactly one of: ${categoryNames.join(", ")} if it clearly fits; otherwise your own short, specific label.`,
              },
              sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
              sheetName: { type: "string", description: "The exact sheet name this item came from." },
              alternateGroupLabel: {
                type: ["string", "null"],
                description:
                  "Null for almost every item. Set ONLY when this row's own sheet is one of several mutually-exclusive alternatives for the same scope, with real textual evidence in the spreadsheet itself (an explicit comparison sheet, \"Option A/B\" language, \"the only difference is...\" framing) -- never because two sheets merely seem similar. Every row from every alternative sheet in the same choice must share the exact same label text (e.g. \"Video Package: LED Ceiling vs Projection Ceiling\").",
              },
            },
            required: ["description", "qty", "qtyIsExplicit", "unit", "unitCost", "unitCostIsExplicit", "category", "sourceQuote", "sheetName", "alternateGroupLabel"],
          },
        },
      },
      required: ["items"],
    },
  } as const;
}

function buildSystemPrompt(categoryNames: string[]): string {
  return `You read a pricing/bid spreadsheet for an event/exhibit contractor -- one whose layout doesn't match either of this app's known deterministic formats -- and propose a list of real, priced line items from it.

Real spreadsheets in this business take many shapes: a flat schedule, one sheet per booth component with sub-tables, or a vendor bid organized by equipment package with pricing only at the package level. Read the structure of THIS sheet and propose items that reflect it honestly:
- If a row has its own real quantity and unit cost, propose it directly with both flagged explicit.
- If pricing exists only as one subtotal covering a whole package/group of components listed under it, propose ONE line item for that package using its own real subtotal as unitCost (qty 1) -- never invent a price for an individual component that doesn't have one, and never split a group price across its members.
- Skip section headers, narrative notes, and a running subtotal/grand-total row that only re-sums other rows you're already proposing separately -- never double-count a total you've already captured item by item.
- A tax, fee, or service charge with its own real, separately-stated dollar amount owed on top of the itemized costs is a real payable cost, not a running total -- propose it. Likewise propose labor, crew day-rates, design fees, and other real services the same way you'd propose a rented item: a service actually being performed or charged for is exactly as real a cost as something supplied, built, or rented.
- sourceQuote must be a real, exact substring of the row's own text as given -- this is how a reviewer verifies and jumps back to the source; never paraphrase it.
- If a quantity truly isn't stated anywhere for a real priced item, use 1 and set qtyIsExplicit to false rather than guessing a number.
- alternateGroupLabel: null for almost every item. Only set it when the spreadsheet itself gives you real evidence that this row's sheet is one of several mutually-exclusive alternatives for the same scope -- an explicit comparison sheet, "Option A/B" wording, or a note like "the only difference between these is...". Every row from every alternative sheet in that same choice must share the exact same label text. Do not set this just because two sheets look similar or cover related equipment -- only when the document itself frames them as a choice between alternatives.

category must be exactly one of: ${categoryNames.join(", ")} when the item clearly fits one of those; otherwise use your own short, specific label rather than forcing a bad fit. If an Audio/Visual category is offered, use it for screens/monitors/LED video/touch screens rather than Electrical & Lighting (reserve that for house power and task/accent lighting); if a Custom Build category is offered, use it for a fixture built to showcase a specific product rather than a generic structure category.

If the sheet has no real priced content at all, return an empty items array rather than inventing something.`;
}

const MAX_INPUT_CHARS = 150_000;

export interface AiProposedImportPreview {
  kind: "ai-proposed";
  documentId: string;
  filename: string;
  rows: ProposedSpreadsheetLineItem[];
  categories: string[];
}

export interface AlternateGroup {
  alternateGroupLabel: string;
  sheetNames: string[];
  totalBySheet: Record<string, number>;
}

// Pure, separately testable from the OpenAI-calling glue on purpose --
// this only reads what the model already flagged, it never decides
// anything on its own. A "group" of exactly one sheet is dropped (can't
// be an alternative to nothing) -- a defensive floor in case the model
// mislabels a single sheet, so the UI never shows a confusing one-sheet
// "choose between these" banner.
export function findAlternateGroups(rows: ProposedSpreadsheetLineItem[]): AlternateGroup[] {
  const sheetsByLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.alternateGroupLabel) continue;
    if (!sheetsByLabel.has(row.alternateGroupLabel)) sheetsByLabel.set(row.alternateGroupLabel, new Set());
    sheetsByLabel.get(row.alternateGroupLabel)!.add(row.sheetName);
  }

  return [...sheetsByLabel.entries()]
    .filter(([, sheets]) => sheets.size > 1)
    .map(([alternateGroupLabel, sheets]) => {
      const sheetNames = [...sheets];
      const totalBySheet: Record<string, number> = {};
      for (const sheetName of sheetNames) {
        totalBySheet[sheetName] = rows
          .filter((r) => r.sheetName === sheetName && r.alternateGroupLabel === alternateGroupLabel)
          .reduce((sum, r) => sum + r.qty * r.unitCost, 0);
      }
      return { alternateGroupLabel, sheetNames, totalBySheet };
    });
}

// One entry per sheetName the reviewer has an opinion on -- any sheet not
// present here defaults to the base version, which is exactly today's
// (pre-alternate-flagging) behavior, so a document with no
// alternateGroupLabel rows at all needs no change from a caller.
export type SheetDestination = { target: "base" } | { target: "option"; optionName: string };

// Mirrors scope-line-item-service.ts's own buildProposedLineItemMatchesCache,
// just against ProposedSpreadsheetLineItem's differently-shaped rows
// instead of ProposedLineItem -- see that function's own comment for the
// full rationale. Not reused directly since ProposedSpreadsheetLineItem
// has no lineType field, so it isn't structurally assignable to
// ProposedLineItem.
async function buildSpreadsheetMatchesCache(
  rows: ProposedSpreadsheetLineItem[],
  versionId: string | null,
  opportunityId: string,
  documentId: string,
  userId: string | null,
): Promise<{ estimateVersionId: string; matches: LineItemDuplicateMatch[] } | undefined> {
  if (!versionId || rows.length === 0) return undefined;
  const candidates = await loadDuplicateCandidates(versionId);
  // groupKey = the row's own sheet -- same reasoning as
  // module-cost-estimate-import-service.ts's identical use (a generic
  // allowance/label can legitimately repeat once per sheet); this
  // pipeline's own Tier 2 AI pass already covers most ambiguity Tier 1
  // misses, so this is a smaller marginal improvement here than there.
  const proposedForCheck: ProposedItemForDuplicateCheck[] = rows.map((row) => ({
    description: row.description,
    qty: row.qty,
    unit: row.unit,
    groupKey: row.sheetName,
  }));
  const matches = await matchProposedLineItemsAgainstExisting(proposedForCheck, candidates, opportunityId, documentId, userId);
  return { estimateVersionId: versionId, matches };
}

// opportunityId ownership check -- see design-cost-estimate-import-
// service.ts's previewDesignCostEstimateImport for the identical
// rationale (same pipeline family, same gap class this closes). Caches
// the raw AI proposal on Document.proposedLineItems -- the SAME field
// scope-line-item-service.ts already uses for its own (differently
// shaped) proposals; safe to share since a given Document only ever goes
// through one of these two pipelines (a PRICING_SCHEDULE-tagged
// spreadsheet never also gets "Propose items" run on it). Read first, so
// repeated "Preview import" clicks don't re-spend tokens; only a genuinely
// new document (or an explicit re-run) calls OpenAI again.
//
// versionId is optional, same reason as proposeLineItemsFromScope's own
// identical parameter -- when given, this also builds and caches a Tier
// 2 duplicate-match hint onto proposedLineItemMatches (see
// line-item-duplicate-service.ts's own header comment) for the review
// UI's default selection. Only computed on a genuinely fresh AI
// proposal, not on the cached-rows early return below -- Tier 2 here is
// a UI convenience only, and commitAiProposedImport's own fresh Tier 1
// recompute at commit time remains the real safety net regardless of
// whether this cache is present, absent, or stale for a different
// version.
export async function previewAiProposedImport(
  documentId: string,
  opportunityId: string,
  userId: string | null = null,
  versionId: string | null = null,
): Promise<AiProposedImportPreview> {
  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  const cached = document.proposedLineItems as unknown as ProposedSpreadsheetLineItem[] | null;
  if (cached && cached.length > 0) {
    return {
      kind: "ai-proposed",
      documentId,
      filename: document.filename,
      rows: cached,
      categories: [...new Set(cached.map((r) => r.category))],
    };
  }

  const client = getOpenAiClient(); // throws AiNotConfiguredError before any DB write, same posture as every other AI proposer

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const serialized = serializeWorkbookForPrompt(workbook).slice(0, MAX_INPUT_CHARS);

  const liveCategories = await db.category.findMany({ where: { deletedAt: null } });
  const categoryNames = liveCategories.map((c) => c.name);

  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL, // reasoning over an unfamiliar document structure to infer real vs. package-level pricing -- exactly the case openai-client.ts's own model-tiering reserves ADVANCED_MODEL for
    temperature: 0.2,
    messages: [
      { role: "system", content: buildSystemPrompt(categoryNames) },
      { role: "user", content: `Spreadsheet: ${document.filename}\n\n${serialized}` },
    ],
    response_format: { type: "json_schema", json_schema: buildSpreadsheetProposalSchema(categoryNames) },
  });

  await recordAiUsage({
    userId,
    feature: "SPREADSHEET_LINE_ITEMS",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    documentId,
    opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { items: ProposedSpreadsheetLineItem[] };

  const matchesCache = await buildSpreadsheetMatchesCache(parsed.items, versionId, opportunityId, documentId, userId);

  await db.document.update({
    where: { id: documentId },
    data: {
      proposedLineItems: parsed.items as unknown as Prisma.InputJsonValue,
      ...(matchesCache ? { proposedLineItemMatches: matchesCache as unknown as Prisma.InputJsonValue } : {}),
    },
  });

  return {
    kind: "ai-proposed",
    documentId,
    filename: document.filename,
    rows: parsed.items,
    categories: [...new Set(parsed.items.map((r) => r.category))],
  };
}

// Same idempotency-guard/findOrCreateSection/addLineItemsBulk shape every
// other importer in this app already uses, extended two ways:
//
// - Sections are now grouped by (sheetName, category), not category
//   alone -- mirrors design-cost-estimate-import-service.ts's own
//   (boothLabel, category) grouping exactly. Confirmed necessary live: a
//   real job's 67 committed items all landed in flat, generic category
//   buckets with zero sub-structure, because this importer never passed
//   groupLabel the way every other one in this app does.
// - sheetDestinations lets a reviewer route a specific sheet's rows into
//   a real Option instead of the base version -- see
//   findAlternateGroups's own header comment for why this exists. A
//   sheet with no entry here (the overwhelming common case) goes to the
//   base version, unchanged from this function's original behavior.
//
// isDraft is still implied true for every row with no exception --
// addLineItemsBulk's own default -- AI-derived pricing needs human
// confirmation MORE than a deterministic import does, never less.
//
// selectedIndices is optional and, when given, indexes into preview.rows
// (there's no separate project-filtering pass here the way
// commitScopeLineItems has, so this pipeline's index space is simply the
// row's own position in preview.rows) -- same contract as
// commitScopeLineItems's own identical parameter: omitted falls back to
// a safe default (every row minus fresh Tier 1 exact duplicates and
// cached high-confidence Tier 2 matches), given trusts it exactly as-is.
export async function commitAiProposedImport(
  estimateVersionId: string,
  documentId: string,
  sheetDestinations: Record<string, SheetDestination> = {},
  selectedIndices?: number[],
) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimate: { select: { opportunityId: true } } },
  });
  const preview = await previewAiProposedImport(documentId, version.estimate.opportunityId);
  if (preview.rows.length === 0) {
    throw new Error(`No line items could be proposed from "${preview.filename}".`);
  }

  // Tier 1 (free, deterministic) always recomputed fresh here against the
  // REAL commit target's current line items -- never just trusted from
  // whatever was cached at Preview time. See
  // line-item-duplicate-service.ts's own header comment, and
  // scope-line-item-service.ts's commitScopeLineItems for the identical
  // pattern this mirrors.
  const duplicateCandidates = await loadDuplicateCandidates(estimateVersionId);
  const proposedForDuplicateCheck: ProposedItemForDuplicateCheck[] = preview.rows.map((row) => ({
    description: row.description,
    qty: row.qty,
    unit: row.unit,
    groupKey: row.sheetName,
  }));
  const exactDuplicates = findExactDuplicates(proposedForDuplicateCheck, duplicateCandidates);

  // The Tier 2 cache is only trusted when its own stored estimateVersionId
  // still matches the REAL commit target -- a mismatch just means this
  // cache is stale/inapplicable, not that anything is unsafe (fresh Tier
  // 1 above still fully applies regardless).
  const { proposedLineItemMatches } = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { proposedLineItemMatches: true },
  });
  const cached = proposedLineItemMatches as unknown as
    | { estimateVersionId: string; matches: LineItemDuplicateMatch[] }
    | null;
  const cachedMatches = cached?.estimateVersionId === estimateVersionId ? cached.matches : null;

  const defaultExcludedIndices = new Set<number>();
  preview.rows.forEach((_, index) => {
    if (exactDuplicates.has(index)) {
      defaultExcludedIndices.add(index);
      return;
    }
    if (cachedMatches?.[index]?.confidence === "high") {
      defaultExcludedIndices.add(index);
    }
  });

  const selectedRowIndices =
    selectedIndices !== undefined
      ? new Set(selectedIndices)
      : new Set(preview.rows.map((_, index) => index).filter((idx) => !defaultExcludedIndices.has(idx)));

  const rows = preview.rows.filter((_, index) => selectedRowIndices.has(index));

  const liveCategories = await db.category.findMany({ where: { deletedAt: null } });
  const existingSectionCount = await db.estimateSection.count({ where: { estimateVersionId, optionId: null } });

  // Resolve/create every distinct named Option up front, once per name --
  // several sheets could legitimately route to the same new Option.
  const optionIdByName = new Map<string, string>();
  for (const destination of Object.values(sheetDestinations)) {
    if (destination.target === "option" && !optionIdByName.has(destination.optionName)) {
      const option = await addOption(estimateVersionId, { name: destination.optionName });
      optionIdByName.set(destination.optionName, option.id);
    }
  }

  const groupKey = (row: ProposedSpreadsheetLineItem) => `${row.sheetName} ${row.category}`;
  const seenKeys = new Set<string>();
  const groups: { sheetName: string; category: string }[] = [];
  for (const row of rows) {
    const key = groupKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    groups.push({ sheetName: row.sheetName, category: row.category });
  }

  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const group of groups) {
    const destination = sheetDestinations[group.sheetName] ?? { target: "base" as const };
    const optionId = destination.target === "option" ? (optionIdByName.get(destination.optionName) ?? null) : null;

    const section = await findOrCreateSection(estimateVersionId, {
      name: group.category,
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
      groupLabel: group.sheetName,
      optionId,
    });

    const rowsForGroup = rows.filter((r) => groupKey(r) === `${group.sheetName} ${group.category}`);
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      rowsForGroup.map((row) => {
        const description = row.qtyIsExplicit ? row.description : `${row.description}${QTY_ESTIMATED_SUFFIX}`;
        const unit = row.unit || null;
        const resolvedCategory = resolveLineItemCategory({ explicit: row.category, description: row.description }, liveCategories);
        return {
          lineType: "MATERIAL" as const,
          description,
          qty: row.qty,
          unit,
          // The AI's own read of the sheet's real price is the source of
          // truth here, same reasoning as design-cost-estimate-import-
          // service.ts's own commit -- never overridden by a catalog guess.
          unitCost: row.unitCost,
          category: resolvedCategory,
          isClientOwned: false,
          documentId,
          sourceQuote: row.sourceQuote,
          aiProposalSnapshot: {
            description,
            qty: String(row.qty),
            unit,
            unitCost: String(row.unitCost),
            lineType: "MATERIAL" as const,
            category: resolvedCategory,
            aiFeature: "SPREADSHEET_LINE_ITEMS" as const,
          },
        };
      }),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: rows.length };
}
