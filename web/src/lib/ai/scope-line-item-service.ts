// Companion to document-summary-service.ts, but a distinct, explicitly
// triggered operation -- proposing biddable line items from a Scope of
// Work / RFP document's text, for RFP packages that don't come with a
// pre-built Pricing Schedule XLSX (pricing-import-service.ts). Without
// this, such a package converts to an estimate with ZERO line items no
// matter what.
//
// Structurally unlike a real pricing schedule: nothing here has a
// guaranteed real quantity. qtyIsExplicit tells a reviewer which numbers
// actually came from the document text versus which are a bare "1"
// placeholder standing in for "this exists, quantity unknown" -- never
// let the model invent a number that isn't written down.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { AiFeature } from "@/generated/prisma/enums";
import { extractPdfPageTexts, locateQuotePage, resolveHighlightableQuote, PDF_MIME } from "@/lib/ai/text-extraction";
import { ADVANCED_MODEL, BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { addLineItemsBulk, findOrCreateSection } from "@/lib/estimate-service";
import { loadCatalogForMatching, matchDescription } from "@/lib/catalog-match-service";
import { getDocumentBytes } from "@/lib/document-service";
import { withProjectField } from "@/lib/ai/document-summary-service";
import {
  filterBulletsForEstimate,
  getProjectContext,
  resolveProjectTag,
  type ProjectContext,
} from "@/lib/ai/scope-document-context";
import {
  CUSTOM_BUILD_CATEGORY_KEY,
  inferCategoryFromDescription,
  inferIsClientOwned,
  isAlwaysGraphicsDescription,
  isCompoundAssemblyDescription,
  mapCatalogCategoryToCanonical,
  mapScopeCategoryToCanonical,
  resolveCategoryNameFromKey,
} from "@/lib/line-item-category";
import {
  findExactDuplicates,
  matchProposedLineItemsAgainstExisting,
  type ExistingLineItemCandidate,
  type LineItemDuplicateMatch,
  type ProposedItemForDuplicateCheck,
} from "@/lib/ai/line-item-duplicate-service";

// Fixed vocabulary, not free text -- re-running "Propose items" on the
// exact same document used to produce a different taxonomy every time
// ("Doors and Hardware" vs. "Doors and Locks," "Electrical and Lighting"
// vs. folded into "Lighting and Safety"). This list is the merged,
// canonical form of every category name two real AI runs on the same
// document actually produced. "Other" is the deliberate catch-all so a
// genuinely novel scope item never gets force-fit into a wrong bucket.
export const SCOPE_CATEGORIES = [
  "Booth Structure & Walls",
  "Doors & Hardware",
  "Countertops & Cable Management",
  "Electrical & Lighting",
  "Fire & Life Safety",
  "Roof & Coverings",
  "Flooring & Platforms",
  "Labor & Installation",
  "Documentation & Compliance",
  "Other",
] as const;

export type ScopeCategory = (typeof SCOPE_CATEGORIES)[number];

// Appended to a committed LineItem's own description when its quantity
// wasn't explicit in the source (see commitScopeLineItems's per-item
// description below; spreadsheet-line-item-service.ts's commitAiProposedImport
// does the identical thing for its own rows). Shared as a constant, not
// duplicated as a literal in each file, specifically so
// loadDuplicateCandidates below can strip it back off -- otherwise a
// fresh re-proposal's own raw description (never carries this suffix)
// would never exact-match a previously-committed item that DOES, since
// the appended text always differs. Both this constant and the stripping
// live together in this one file since scope-line-item-service.ts is
// where the suffix's own text is authored.
export const QTY_ESTIMATED_SUFFIX = " (qty estimated -- verify)";

// estimateId is optional, same reason as document-summary-service.ts's
// KeyDateFact/CitedText -- undefined (an older cached proposal, from
// before multi-project support) is treated identically to an explicit
// null: shared/unclassified, visible to every estimate. Only ever
// resolved to a real value once an Opportunity has 2+ named Estimates --
// see resolveProjectTag.
export interface ProposedLineItem {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  category: ScopeCategory;
  sourceQuote: string;
  estimateId?: string | null;
  // Only ever set by drawing-line-item-service.ts -- a drawing has no
  // extracted-text layer to search sourceQuote against (see
  // commitScopeLineItems below), so its page number is model-reported and
  // trusted directly instead of computed via locateQuotePage. Absent (not
  // just null) for every text-sourced item.
  pageNumber?: number | null;
  // Set only in multi-project mode, after a second independent
  // classification pass disagrees with the first (see
  // flagUncertainClassifications). Purely advisory -- estimateId above
  // stays whatever the first pass resolved; there's no principled way to
  // know which of two disagreeing runs is "more correct," only that a
  // human should look at this one before committing it. Never persisted
  // onto the committed LineItem -- this is the before-commit catch, the
  // audit tool (line-item-audit-service.ts) remains the after-commit net.
  classificationUncertain?: boolean;
}

// What OpenAI actually returns -- project is only present when the
// request schema asked for it (2+ named Estimates), same split as
// document-summary-service.ts's DocumentSummaryFromAI.
type ProposedLineItemFromAI = {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  category: ScopeCategory;
  sourceQuote: string;
  project?: string;
};

const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from the document text above, showing where this item comes from. Never paraphrase or summarize the quote itself.";

export function buildProposalSchema(projectNames: string[]) {
  return {
    name: "scope_line_items",
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
            ...withProjectField(
              {
                properties: {
                  description: { type: "string" },
                  qty: { type: "number" },
                  qtyIsExplicit: {
                    type: "boolean",
                    description: "True only when qty was actually written in the source text, not inferred or guessed.",
                  },
                  unit: { type: "string", description: "A sensible unit for this item -- EA, SQFT, LF, HR, LOT, etc." },
                  lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"] },
                  category: { type: "string", enum: SCOPE_CATEGORIES },
                  sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
                },
                required: ["description", "qty", "qtyIsExplicit", "unit", "lineType", "category", "sourceQuote"],
              },
              projectNames,
            ),
          },
        },
      },
      required: ["items"],
    },
  } as const;
}

// isTranscript branches the framing for MEETING_NOTES documents -- a real,
// confirmed bug otherwise: the default framing assumes a formal
// deliverable, and a raw meeting transcript (casual dialogue,
// introductions, a real case of the team discussing the estimating
// platform itself rather than the job) made the model return an EMPTY
// items array for a document that, read directly, has 16 real biddable
// items in it. Live-tested against that exact document/model: 0 items
// with the generic framing, 16 with this one, nothing else changed.
// Mirrors meeting-notes-summary-service.ts's own already-proven framing
// for the identical document-type/noise problem.
export function buildSystemPrompt(projectNames: string[], isTranscript: boolean): string {
  const documentDescription = isTranscript
    ? "a meeting transcript, recap, or email thread"
    : "a Scope of Work / RFP document";

  const transcriptGuidance = isTranscript
    ? `\n\nThis is a raw meeting transcript, not a formal deliverable -- it mixes real, price-relevant scope discussion with casual conversation, introductions, and (a real, confirmed case) the team discussing the estimating platform/software itself rather than the job being estimated. Sift through the noise: extract genuine scope items wherever they appear in the transcript, and ignore administrative chatter, introductions, and platform/tooling discussion entirely -- don't let noise elsewhere in the document cause you to return nothing when real scope items are present elsewhere in it.`
    : "";

  const base = `You read ${documentDescription} for an event/exhibit contractor and propose a list of distinct, biddable line items a contractor would need to price to build a complete quote -- the granularity a real pricing schedule would use (e.g. "Booth structure fabrication", "Graphics production", "Installation labor"), not one item paraphrasing the entire scope.

For each item:
- description: name the item at that same biddable granularity, but for a custom-fabricated item -- a built structure, graphic, finish, or design element made specifically for this job rather than an off-the-shelf catalog product or rental -- preserve the source's own specifying language inside the name: the exact material, finish, dimension, or design detail as written (e.g. "single-sided Chinese birch," not a generic paraphrase like "plywood"). That original wording is often the actual spec a shop floor builds from, and a paraphrase can silently lose it. For a standard catalog/rental/labor item, a concise generic name is fine and preferred -- this only matters for items nothing off-the-shelf will satisfy.
- qty: the quantity actually stated in the text if there is one (a count, square footage, linear footage, day count, etc.). If no quantity is stated, use 1 and set qtyIsExplicit to false -- 1 is a placeholder meaning "this item exists, quantity unknown," never a guess at a real number.
- qtyIsExplicit: true ONLY when that qty value was actually written in the source text.
- unit: a sensible unit for this item (EA, SQFT, LF, HR, LOT) -- infer from context if the document doesn't state one.
- lineType: MATERIAL for goods/fabrication, LABOR for installation/labor-only work, FEE for flat fees/rentals/services.
- category: which section this item belongs to.
- sourceQuote: a short verbatim quote copied EXACTLY from the document showing where this item comes from -- an exact substring of the source text, never a paraphrase.${transcriptGuidance}

Only propose items that describe actual work or goods to be provided -- skip administrative, legal, or process clauses entirely. If the document has no concrete scope of deliverables${isTranscript ? " anywhere in it" : ""}, return an empty items array rather than inventing something.

category must be exactly one of: ${SCOPE_CATEGORIES.join(", ")}. Pick the closest fit rather than inventing a new name -- use "Other" only when nothing on the list is a reasonable match. Always use this fixed list, even if a previous run on the same document used different wording.`;

  if (projectNames.length === 0) return base;

  return (
    base +
    `\n\nThis client relationship covers multiple separate projects: ${projectNames.map((n) => `"${n}"`).join(", ")}. Classify which one each proposed item belongs to using the project field -- respond with the exact project name it's for, or "SHARED" only if it genuinely applies to more than one (e.g. a general project-management fee). Get this right: a wrong attribution puts one project's cost in the other project's estimate.`
  );
}

// A second, independent classification pass -- catches the residual risk
// the audit tool (line-item-audit-service.ts) can't: a classification
// that's wrong but internally self-consistent, not drift from a later
// retag. Deliberately NOT a full re-extraction (smaller output, and
// avoids the "did the two runs even extract the same items" matching
// problem) -- it's handed the already-extracted item descriptions and
// asked to classify each one again from scratch, with the same full
// document context project attribution actually needs (see every other
// comment on this in the file), but never shown its own first answer, to
// avoid anchoring on it.
function buildReclassificationSchema(projectNames: string[]) {
  return {
    name: "project_reclassification",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        classifications: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string", description: "Copied EXACTLY from the item list above -- used to match this classification back to the right item." },
              project: {
                type: "string",
                description: `Which project this item belongs to. Respond with EXACTLY one of: ${projectNames.map((n) => JSON.stringify(n)).join(", ")} -- or "SHARED" if it genuinely applies to more than one.`,
              },
            },
            required: ["description", "project"],
          },
        },
      },
      required: ["classifications"],
    },
  } as const;
}

function buildReclassificationPrompt(projectNames: string[]): string {
  return `You are independently classifying which project each of a list of already-identified line items belongs to, using the full document text below for context. This client relationship covers multiple separate projects: ${projectNames.map((n) => `"${n}"`).join(", ")}.

For each item in the list you're given, read the document text and determine which project it belongs to from the surrounding context -- respond with the exact project name, or "SHARED" only if it genuinely applies to more than one. Classify every item in the list, in the same order, copying its description back exactly.`;
}

// Pure and separately testable from the OpenAI-calling glue on purpose --
// this is the actual detection logic (matching + disagreement), and it
// shouldn't need a live API key to verify it's correct. estimateId stays
// whatever the first pass resolved either way; disagreement only adds a
// visible "verify this one" flag; it never overrides anything. An item
// missing from the second pass (shouldn't happen, same input list both
// times) is left unflagged rather than guessed at.
export function flagUncertainClassifications(
  firstPass: ProposedLineItem[],
  secondPassClassifications: { description: string; project: string }[],
  context: ProjectContext,
): ProposedLineItem[] {
  const secondProjectByDescription = new Map(secondPassClassifications.map((c) => [c.description, c.project]));
  return firstPass.map((item) => {
    const secondProject = secondProjectByDescription.get(item.description);
    if (secondProject === undefined) return item;
    const secondEstimateId = resolveProjectTag(secondProject, context);
    const firstEstimateId = item.estimateId ?? null;
    return firstEstimateId === secondEstimateId ? item : { ...item, classificationUncertain: true };
  });
}

// Same ceiling and reasoning as document-summary-service.ts's own
// MAX_INPUT_CHARS: this used to be 60_000 on the assumption every real
// document stays under it, which a real 73,764-character Full Swing
// meeting transcript disproved -- the old cap silently dropped the last
// ~19% of that document from every "Propose items" run on it.
const MAX_INPUT_CHARS = 150_000;

// opportunityId is the caller's already-access-checked opportunity, NOT
// trusted from documentId alone -- this is a cost-bearing AI call that
// also WRITES its result back onto the document (proposedLineItems
// below), so the ownership check doubles as protection against both
// spending someone else's AI budget AND overwriting another
// opportunity's document with this caller's classification. See
// pricing-import-service.ts's previewPricingImport for the same
// rationale on the read-only sibling of this pipeline.
export async function proposeLineItemsFromScope(
  documentId: string,
  opportunityId: string,
  userId: string | null = null,
  // Optional: which version this proposal is FOR, so a fresh Tier 2
  // duplicate-match cache can be built against that version's real
  // current line items and stored onto proposedLineItemMatches below --
  // see line-item-duplicate-service.ts's own header comment. Omitted by
  // callers with no particular version in view (this file's own
  // regression tests, an older client) -- proposedLineItemMatches is
  // simply left untouched in that case; commitScopeLineItems's own fresh
  // Tier 1 recompute remains the real safety net regardless.
  versionId: string | null = null,
) {
  const document = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId } });
  if (!document.extractedText) {
    throw new Error(`"${document.filename}" hasn't been analyzed yet -- click Analyze on it first.`);
  }

  // Throws AiNotConfiguredError before any DB write, same posture as
  // summarizeDocument -- a missing key is a configuration problem the
  // caller surfaces distinctly, not a reason to write a broken result.
  const client = getOpenAiClient();

  // A manually-tagged document (see Document.estimateId) already has a
  // known answer -- skip asking the model to classify at all, same
  // shortcut as document-summary-service.ts's summarizeDocument. Only a
  // genuinely untagged document, on an Opportunity with 2+ named
  // Estimates, gets project classification requested per-item.
  const projectContext = document.estimateId ? { estimates: [] } : await getProjectContext(document.opportunityId);
  const projectNames = projectContext.estimates.map((e) => e.name);
  // Same upgrade document-summary-service.ts's summarizeDocument already
  // makes, for the same reason: correctly attributing an item to one of
  // two real projects is a judgment call (surrounding context, not
  // keyword matching), not the kind of extraction BASIC_MODEL is reliable
  // at. Confirmed necessary by a live run against the real Full Swing
  // data -- BASIC_MODEL returned "SHARED" for every single item proposed
  // from one particular meeting transcript (including ones a human reader
  // can tell belong to one specific project), while the exact same
  // multi-project prompt on ADVANCED_MODEL classified correctly.
  const model = projectNames.length > 0 ? ADVANCED_MODEL : BASIC_MODEL;
  const isTranscript = document.documentType === "MEETING_NOTES";
  const truncatedText = document.extractedText.slice(0, MAX_INPUT_CHARS);

  const completion = await client.chat.completions.create({
    model,
    // Low, not zero -- this is exhaustive extraction against a fixed
    // taxonomy, not creative writing, so the API default's high
    // randomness only costs completeness/consistency here. This call was
    // missing the pin every other structured-extraction call in this app
    // has -- the same gap found (and fixed) in drawing-summary-service.ts.
    temperature: 0.2,
    messages: [
      { role: "system", content: buildSystemPrompt(projectNames, isTranscript) },
      { role: "user", content: `Document: ${document.filename}\n\n${truncatedText}` },
    ],
    response_format: { type: "json_schema", json_schema: buildProposalSchema(projectNames) },
  });

  await recordAiUsage({
    userId,
    feature: "SCOPE_LINE_ITEMS",
    model,
    usage: completion.usage,
    documentId,
    opportunityId: document.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { items: ProposedLineItemFromAI[] };

  // Same discipline as document-summary-service.ts: resolve every quote
  // against the real extracted text so the preview table's quote is a
  // genuine excerpt, not whatever the model happened to return, and
  // resolve each item's model-reported `project` string (present only
  // when projectNames was non-empty) against real Estimate rows -- never
  // trusted raw. A manually-tagged document never asked for `project` in
  // the first place, so every item just inherits document.estimateId.
  const items: ProposedLineItem[] = parsed.items.map(({ project, ...item }) => ({
    ...item,
    sourceQuote: resolveHighlightableQuote(document.extractedText!, item.sourceQuote),
    estimateId: document.estimateId ?? resolveProjectTag(project, projectContext),
  }));

  // Self-consistency re-check -- only when there's a real multi-project
  // classification to doubt in the first place, and something was
  // actually proposed. Roughly doubles this call's input-token cost, but
  // only for multi-project mode (already the minority case) -- see
  // flagUncertainClassifications for what this actually catches.
  const finalItems =
    projectNames.length > 0 && items.length > 0
      ? await reclassifyForConsistency(client, document, truncatedText, items, projectContext, projectNames, userId)
      : items;

  const matchesCache = await buildProposedLineItemMatchesCache(
    finalItems,
    versionId,
    document.opportunityId,
    documentId,
    userId,
  );

  return db.document.update({
    where: { id: documentId },
    data: {
      proposedLineItems: finalItems as unknown as Prisma.InputJsonValue,
      // Omitted entirely (not set to null) when there's no versionId or
      // nothing was proposed -- leaves any previously cached value alone
      // rather than clobbering it with an empty one.
      ...(matchesCache ? { proposedLineItemMatches: matchesCache as unknown as Prisma.InputJsonValue } : {}),
    },
  });
}

async function reclassifyForConsistency(
  client: ReturnType<typeof getOpenAiClient>,
  document: { id: string; opportunityId: string },
  truncatedText: string,
  items: ProposedLineItem[],
  projectContext: ProjectContext,
  projectNames: string[],
  userId: string | null,
): Promise<ProposedLineItem[]> {
  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: buildReclassificationPrompt(projectNames) },
      {
        role: "user",
        content: `Document text:\n\n${truncatedText}\n\n---\n\nItems to classify:\n${items.map((i) => `- ${i.description}`).join("\n")}`,
      },
    ],
    response_format: { type: "json_schema", json_schema: buildReclassificationSchema(projectNames) },
  });

  await recordAiUsage({
    userId,
    feature: "SCOPE_LINE_ITEMS",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    documentId: document.id,
    opportunityId: document.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) return items; // a transient hiccup on the re-check shouldn't lose the primary proposal
  const parsed = JSON.parse(content) as { classifications: { description: string; project: string }[] };
  return flagUncertainClassifications(items, parsed.classifications, projectContext);
}

// Shared by the Propose-time caching call (below) and commitScopeLineItems's
// own fresh Tier 1 recompute -- both need the same "every current LineItem
// in this version, outside any Option" candidate pool. optionId: null
// matches the old whole-document guard's own scope exactly (see this
// function's callers).
export async function loadDuplicateCandidates(estimateVersionId: string): Promise<ExistingLineItemCandidate[]> {
  const [existing, sections] = await Promise.all([
    db.lineItem.findMany({
      where: { section: { estimateVersionId, optionId: null } },
      select: {
        id: true,
        description: true,
        qty: true,
        unit: true,
        section: { select: { id: true, groupLabel: true, name: true } },
      },
    }),
    // EstimateSection.groupLabel is overloaded: a fresh Excel import (see
    // module-cost-estimate-import-service.ts etc.) sets it to the source
    // file's own sheet/booth name, but estimate-service.ts's booth-merge
    // feature (mergeBoothIntoAnotherBooth) REUSES the same field to link
    // a merged child section back to its H1 wrapper section's own id --
    // confirmed live against a real production estimate, where several
    // merged sections' groupLabel had become another section's id rather
    // than the module name it used to be. Every section id in this
    // version is fetched so groupKey below can detect that case and fall
    // back to null (never a wrong-but-plausible-looking key) instead of
    // trusting a corrupted "sheet name".
    db.estimateSection.findMany({ where: { estimateVersionId }, select: { id: true } }),
  ]);
  const sectionIds = new Set(sections.map((s) => s.id));
  return existing.map((li) => ({
    id: li.id,
    // Strips QTY_ESTIMATED_SUFFIX back off before comparison -- see that
    // constant's own comment for why: a fresh proposal's raw description
    // never carries it, so leaving it on here would silently break exact
    // matching for every non-explicit-quantity item, the common case.
    description: li.description.endsWith(QTY_ESTIMATED_SUFFIX)
      ? li.description.slice(0, -QTY_ESTIMATED_SUFFIX.length)
      : li.description,
    sectionLabel: li.section.groupLabel ?? li.section.name,
    // LineItem.qty is a Prisma Decimal -- ExistingLineItemCandidate.qty
    // only needs plausibility context for the AI prompt, not precision.
    qty: li.qty != null ? Number(li.qty) : null,
    unit: li.unit,
    groupKey: li.section.groupLabel && !sectionIds.has(li.section.groupLabel) ? li.section.groupLabel : null,
  }));
}

// Builds the Tier 2 cache payload for Document.proposedLineItemMatches --
// used by proposeLineItemsFromScope and proposeLineItemsFromDrawing right
// after a fresh proposal is generated. Purely a UI/default-selection
// convenience (see this file's own line-item-duplicate-service.ts import
// header comment) -- returns undefined (caller then leaves
// proposedLineItemMatches untouched) when there's no version context to
// match against yet, or nothing was proposed to check in the first place.
export async function buildProposedLineItemMatchesCache(
  items: ProposedLineItem[],
  versionId: string | null,
  opportunityId: string,
  documentId: string,
  userId: string | null,
): Promise<{ estimateVersionId: string; matches: LineItemDuplicateMatch[] } | undefined> {
  if (!versionId || items.length === 0) return undefined;
  const candidates = await loadDuplicateCandidates(versionId);
  // No per-row grouping concept for scope/drawing text -- goes straight
  // to findExactDuplicates's own description-only fallback pass. Tier 2
  // (the AI call below) is what actually carries most of the
  // disambiguation weight for this pipeline anyway.
  const proposedForCheck: ProposedItemForDuplicateCheck[] = items.map((item) => ({
    description: item.description,
    qty: item.qty,
    unit: item.unit,
    groupKey: null,
  }));
  const matches = await matchProposedLineItemsAgainstExisting(proposedForCheck, candidates, opportunityId, documentId, userId);
  return { estimateVersionId: versionId, matches };
}

export interface ProposedItemDuplicateStatus {
  match: LineItemDuplicateMatch;
  // Whether this index is part of the safe default selection -- the same
  // rule commitScopeLineItems applies internally when selectedIndices is
  // omitted (exclude a fresh Tier 1 exact match or a cached
  // high-confidence Tier 2 match, include everything else).
  selected: boolean;
}

// Read-only counterpart to commitScopeLineItems's own default-selection
// logic, for the review UI (estimates/[id]/page.tsx) to render a
// confidence badge per proposed row and seed MatchSelectionProvider's
// starting checkbox state -- never writes anything, just the same
// LineItem lookup loadDuplicateCandidates always does. Kept as its own
// simpler function rather than sharing commitScopeLineItems's internals:
// this operates on the RAW, unfiltered proposedLineItems array (the same
// index space the review UI's checkboxes, selectedIndices, and cached
// Tier 2 matches all use), while commitScopeLineItems's own computation
// happens after its own project-filtering step and works in
// originalIndex terms. items only needs description/qty/unit -- accepts
// anything structurally compatible with ProposedLineItem or
// ProposedSpreadsheetLineItem so both review tables can share this.
// qty/unit are nullable -- ParsedDesignCostRow/ParsedModuleCostRow (the
// deterministic Excel parsers' own row shapes) have no unit field at
// all, and findExactDuplicates only ever reads description (and
// groupKey, when set) anyway. groupKey is optional -- omitted (or null)
// for the scope/drawing Propose card, which has no per-row grouping
// concept; the deterministic Excel import-preview card passes the
// source file's own sheet/booth name per row so findExactDuplicates can
// use its narrower first pass -- see that function's own comment.
export async function resolveDuplicateStatusForReview(
  items: { description: string; qty: number | null; unit: string | null; groupKey?: string | null }[],
  estimateVersionId: string,
  // Only pass the cache's own matches when its stored estimateVersionId
  // still equals estimateVersionId above -- a stale cache for a
  // different version should be treated the same as no cache at all.
  cachedMatches: LineItemDuplicateMatch[] | null,
): Promise<ProposedItemDuplicateStatus[]> {
  if (items.length === 0) return [];
  const candidates = await loadDuplicateCandidates(estimateVersionId);
  const proposedForCheck: ProposedItemForDuplicateCheck[] = items.map((item) => ({
    description: item.description,
    qty: item.qty,
    unit: item.unit,
    groupKey: item.groupKey ?? null,
  }));
  const exactMatches = findExactDuplicates(proposedForCheck, candidates);

  return items.map((_, index) => {
    const exact = exactMatches.get(index);
    const match: LineItemDuplicateMatch = exact
      ? { existingLineItemId: exact.id, confidence: "high", reasoning: "Exact match against an existing line item's description." }
      : (cachedMatches?.[index] ?? { existingLineItemId: null, confidence: null, reasoning: null });
    return { match, selected: match.confidence !== "high" };
  });
}

// Creates one EstimateSection per distinct category (mirroring
// pricing-import-service.ts's commitPricingImport) and bulk-inserts every
// proposed item as an isDraft LineItem, seeding a catalog-matched unitCost
// the same way an imported pricing-schedule row does. A qty that wasn't
// explicitly stated in the source gets flagged right in the description
// text -- LineItem has no separate field for "this quantity is a
// placeholder," and burying that caveat only in a preview table that
// disappears after commit would let it silently get treated as real.
//
// selectedIndices is optional and, when given, indexes into the RAW
// document.proposedLineItems array (before this function's own project
// filtering below) -- the same index space the review UI's checkboxes and
// the cached Tier 2 matches both use. Omitted (every non-UI caller: the
// plain-form fallback, buildEstimateFromAllDocuments, every existing
// test) -- falls back to a safe default: every item minus whatever fresh
// Tier 1 (recomputed here, not trusted from any cache) and cached
// high-confidence Tier 2 matches flag as an already-existing duplicate.
// Given explicitly (the review-table UI path) -- trusted exactly as
// given, never silently overridden, so a human can deliberately commit a
// flagged "duplicate" anyway.
export async function commitScopeLineItems(estimateVersionId: string, documentId: string, selectedIndices?: number[]) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    include: { estimate: { select: { opportunityId: true } } },
  });
  // documentId scoped by the SAME opportunity estimateVersionId belongs
  // to, not trusted alone -- see proposeLineItemsFromScope's own header
  // comment for the full rationale (same pipeline, same gap class).
  const document = await db.document.findFirstOrThrow({
    where: { id: documentId, opportunityId: version.estimate.opportunityId },
  });
  const allItems = (document.proposedLineItems as unknown as ProposedLineItem[] | null) ?? [];
  if (allItems.length === 0) {
    throw new Error(`No proposed line items for "${document.filename}" -- click Propose items first.`);
  }

  // originalIndex is tracked through project-filtering below so the
  // duplicate-selection logic that follows (selectedIndices, the cached
  // Tier 2 matches) can be resolved against the SAME index space the
  // review UI uses -- indices into the raw, unfiltered proposedLineItems
  // array, not this post-filter list.
  const allItemsWithIndex = allItems.map((item, originalIndex) => ({ ...item, originalIndex }));
  // Drops items tagged to a DIFFERENT project's estimate before anything
  // gets written -- a shared/untagged document's proposal is generated
  // once (see proposeLineItemsFromScope) and cached on the Document, so
  // committing it into each of an opportunity's estimates must filter to
  // that estimate's own items every time, the same way filterBulletsForEstimate
  // already does for scope-summary bullets.
  const itemsWithIndex = filterBulletsForEstimate(allItemsWithIndex, version.estimateId);
  if (itemsWithIndex.length === 0) {
    throw new Error(`"${document.filename}"'s proposed items all belong to a different project in this Opportunity -- nothing to commit here.`);
  }

  // Tier 1 (free, deterministic) is always recomputed fresh here against
  // the REAL commit target's current line items -- never just trusted
  // from whatever was cached at Propose time (see
  // line-item-duplicate-service.ts's own header comment for why: Propose
  // is document/opportunity-scoped, and the version current now can
  // differ from whichever version was current when Propose last ran).
  // This alone is what replaces the old whole-document guard's safety
  // guarantee for the identical-document-recommit case.
  const duplicateCandidates = await loadDuplicateCandidates(estimateVersionId);
  const proposedForDuplicateCheck: ProposedItemForDuplicateCheck[] = itemsWithIndex.map((item) => ({
    description: item.description,
    qty: item.qty,
    unit: item.unit,
    groupKey: null,
  }));
  const exactDuplicates = findExactDuplicates(proposedForDuplicateCheck, duplicateCandidates);

  // The Tier 2 cache is only trusted when its own stored estimateVersionId
  // still matches the REAL commit target -- a mismatch just means this
  // cache is stale/inapplicable (fresh Tier 1 above still fully applies),
  // not that anything is unsafe.
  const cached = document.proposedLineItemMatches as unknown as
    | { estimateVersionId: string; matches: LineItemDuplicateMatch[] }
    | null;
  const cachedMatches = cached?.estimateVersionId === estimateVersionId ? cached.matches : null;

  const defaultExcludedOriginalIndices = new Set<number>();
  itemsWithIndex.forEach((item, localIndex) => {
    if (exactDuplicates.has(localIndex)) {
      defaultExcludedOriginalIndices.add(item.originalIndex);
      return;
    }
    if (cachedMatches?.[item.originalIndex]?.confidence === "high") {
      defaultExcludedOriginalIndices.add(item.originalIndex);
    }
  });

  const selectedOriginalIndices =
    selectedIndices !== undefined
      ? new Set(selectedIndices)
      : new Set(
          itemsWithIndex.map((item) => item.originalIndex).filter((idx) => !defaultExcludedOriginalIndices.has(idx)),
        );

  const items = itemsWithIndex.filter((item) => selectedOriginalIndices.has(item.originalIndex));

  const catalog = await loadCatalogForMatching();
  const liveCategories = await db.category.findMany({ where: { deletedAt: null } });
  const categories = [...new Set(items.map((i) => i.category))];

  // pageNumber is computed here, not stored at propose time -- same
  // reasoning as document-summary-service.ts: searching the PDF's own
  // per-page text for each already-verified sourceQuote is trustworthy in
  // a way an LLM-reported page number wouldn't be. DOCX has no page
  // concept; those items get a text-search highlight in the viewer
  // instead (sourcePageNumber stays null, sourceQuote still links there).
  let pageTexts: string[] | null = null;
  if (document.mimeType === PDF_MIME) {
    const { bytes } = await getDocumentBytes(documentId);
    pageTexts = await extractPdfPageTexts(bytes);
  }

  const existingSectionCount = await db.estimateSection.count({ where: { estimateVersionId, optionId: null } });
  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const category of categories) {
    // Reuses an existing section of the same name in this version rather
    // than creating a duplicate -- matters once more than one document is
    // committed into the same version (see estimate-synthesis-service.ts),
    // where two documents proposing the same category (e.g. "Other") used
    // to produce two separate sections on a real test job.
    const section = await findOrCreateSection(estimateVersionId, {
      name: category,
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
    });

    // Roadmap: the AI accuracy signal (LineItemAccuracyFlag) needs to know
    // which AI feature actually proposed this item -- both scope-text and
    // drawing-sourced items flow through this one commit function (see
    // ProposedLineItem's own comment), distinguished only by the
    // document they came from.
    const aiFeature: AiFeature = document.documentType === "DRAWING" ? "DRAWING_LINE_ITEMS" : "SCOPE_LINE_ITEMS";

    const itemsForCategory = items.filter((i) => i.category === category);
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      itemsForCategory.map((item) => {
        const catalogMatch = matchDescription(item.description, catalog);
        const description = item.qtyIsExplicit ? item.description : `${item.description}${QTY_ESTIMATED_SUFFIX}`;
        const unit = item.unit || null;
        const unitCost = catalogMatch?.unitCost ?? 0;
        // A compound "Complete X Build" assembly line wins outright (see
        // line-item-category.ts -- catalog match is unreliable against
        // that much text). SEG is checked next -- confirmed live as a
        // real miscategorization: the AI's own coarse scope bucket (e.g.
        // "Booth Structure & Walls") otherwise wins over the item's own
        // description for every line in that bucket, including SEG
        // fabric graphics lines that don't belong there (see
        // isAlwaysGraphicsDescription's own comment -- same bug pattern
        // already fixed in design-cost-estimate-import-service.ts).
        // Otherwise prefer a confident catalog match's own category over
        // the AI's coarser scope bucket, and fall back to the
        // description heuristic only if neither resolved.
        const resolvedCategory =
          isCompoundAssemblyDescription(item.description)
            ? resolveCategoryNameFromKey(liveCategories, CUSTOM_BUILD_CATEGORY_KEY)
            : (isAlwaysGraphicsDescription(item.description) ? resolveCategoryNameFromKey(liveCategories, "graphics") : null) ??
              mapCatalogCategoryToCanonical(catalogMatch?.category, liveCategories) ??
              mapScopeCategoryToCanonical(category, liveCategories) ??
              inferCategoryFromDescription(item.description, liveCategories);
        return {
          lineType: item.lineType,
          description,
          qty: item.qty,
          unit,
          unitCost,
          category: resolvedCategory,
          isClientOwned: inferIsClientOwned(item.description),
          documentId,
          sourceQuote: item.sourceQuote,
          sourcePageNumber: item.pageNumber ?? (pageTexts ? locateQuotePage(pageTexts, item.sourceQuote) : null),
          aiProposalSnapshot: {
            description,
            qty: String(item.qty),
            unit,
            unitCost: String(unitCost),
            lineType: item.lineType,
            category: resolvedCategory,
            aiFeature,
          },
        };
      }),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: document.filename, sectionsCreated: created.length, rowsImported: items.length };
}
