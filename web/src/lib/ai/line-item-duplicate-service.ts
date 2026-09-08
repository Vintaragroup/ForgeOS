// Detects when a newly AI-proposed line item (from re-scanning the same
// document, or scanning a different one describing overlapping scope) is
// actually a duplicate of a LineItem that already exists in the target
// estimate version -- so a re-scan proposes only what's genuinely
// missing instead of blindly re-inserting everything. See
// schema.prisma's own Document.proposedLineItemMatches comment for the
// caching contract this feeds, and scope-line-item-service.ts /
// spreadsheet-line-item-service.ts for the two callers that actually use
// this at Propose and Commit time.
//
// Two-tier design, mirroring vendor-match-ai-service.ts's own structure
// (same confidence levels, same "leave unmatched rather than guess"
// posture, same ADVANCED_MODEL/json_schema pattern):
//
// Tier 1 (findExactDuplicates, below) -- free, deterministic, always
// recomputed fresh at commit time (never just trusted from a cache): an
// exact normalized-description match against an existing LineItem, only
// trusted when unambiguous (exactly one existing candidate shares that
// normalized description). This alone replaces the old whole-document
// commit guard's own safety guarantee for the identical-document-
// recommit case, with zero AI dependency.
//
// Tier 2 (matchProposedLineItemsAgainstExisting's AI call, below) --
// best-effort, one joint call given every remaining proposed item and
// every remaining existing line item at once (not pairwise), so the
// model reasons globally. Cached at Propose time purely as a UI
// convenience for pre-selecting which rows a review table defaults to
// committing -- Commit itself always re-derives Tier 1 fresh regardless
// of what's cached, since "Propose items" is document/opportunity-scoped
// while the version current at Commit time can differ from whichever
// version was current when Propose last ran.
//
// Unlike vendor-match-ai-service.ts's own one-vendor-line-per-candidate
// constraint, no forced one-winner dedup happens here -- two different
// proposed rows both legitimately matching the same existing item is a
// valid outcome (e.g. two overlapping re-scans both re-describing one
// real existing item), not a conflict to resolve.

import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";

export type DuplicateMatchConfidence = "high" | "medium" | "low";

// Deliberately minimal -- callers (scope/drawing's ProposedLineItem,
// spreadsheet's own row shape) each map their own richer type down to
// this before calling in, so this file stays independent of either
// pipeline's specific shape.
export interface ProposedItemForDuplicateCheck {
  description: string;
  qty: number | null;
  unit: string | null;
}

export interface ExistingLineItemCandidate {
  id: string;
  description: string;
  // EstimateSection.groupLabel ?? name -- real signal when it happens to
  // help, never a guaranteed key. Same role as MatchCandidate.sectionLabel
  // in vendor-match-ai-service.ts.
  sectionLabel: string | null;
  qty: number | null;
  unit: string | null;
}

// Parallel-indexed to the proposedItems array a caller passed in -- see
// schema.prisma's own Document.proposedLineItemMatches comment. Index i
// here always describes proposedItems[i], whether it was resolved by
// Tier 1 or Tier 2 (or left unmatched by neither).
export interface LineItemDuplicateMatch {
  existingLineItemId: string | null;
  confidence: DuplicateMatchConfidence | null;
  reasoning: string | null;
}

const REASONING_DESCRIPTION =
  "Under 100 characters: the specific reason this proposed item does (or doesn't) already exist on the estimate.";

export const DUPLICATE_MATCH_SCHEMA = {
  name: "line_item_duplicate_matches",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            proposedIndex: {
              type: "integer",
              description: "The proposed item's own index, exactly as numbered in the PROPOSED ITEMS list above.",
            },
            candidateIndex: {
              type: ["integer", "null"],
              description:
                "The matched existing line item's own index, exactly as numbered in the EXISTING LINE ITEMS list above, or null if this proposed item doesn't already exist on the estimate.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "How confident you are this proposed item is a duplicate. \"low\" (or a null candidateIndex) means a human should review it.",
            },
            reasoning: { type: "string", description: REASONING_DESCRIPTION },
          },
          required: ["proposedIndex", "candidateIndex", "confidence", "reasoning"],
        },
      },
    },
    required: ["matches"],
  },
} as const;

const SYSTEM_PROMPT = `You are checking whether each of a batch of newly AI-proposed line items is already represented among an estimate's existing line items -- for example, from an earlier import of the same document being re-scanned, or from a different document describing overlapping scope. Both lists describe real, physical scope of work for the same job.

Below you'll see:
- PROPOSED ITEMS: every newly proposed line item, numbered, with its own quantity/unit where known.
- EXISTING LINE ITEMS: every line item already on this estimate, numbered, each with its own section label (if grouped) and quantity/unit.

For EACH proposed item, decide whether it's a duplicate of one of the existing line items, using:
- Description similarity -- usually the most reliable signal. A proposed item can be worded differently than the existing item it duplicates (different phrasing, more or less detail) and still be the same real thing.
- Quantity/unit plausibility -- a genuine duplicate usually describes the same real quantity of the same real thing, though a re-scan can legitimately produce a slightly different quantity for the same item.
- The existing item's own section label, when it gives a real hint -- never a guaranteed key on its own.

This is asking "does this already exist," not "what's the closest existing item" -- most proposed items will have NO duplicate (that's the normal, expected case for a genuinely new item), so leave candidateIndex null and use confidence "low" whenever you're genuinely unsure, rather than guessing. A wrongly-suppressed real item that never gets added to the estimate is worse than one extra visible row a human reviewer can simply uncheck -- only report high or medium confidence when the match is actually clear.

Each existing item can legitimately be the duplicate of more than one proposed item (e.g. two different proposed batches both re-describing the same real existing item) -- do not withhold an otherwise-clear match just because another proposed item already matched the same existing item.

Return one matches entry per proposed item, using its exact proposedIndex.`;

// Smaller ceiling than vendor-match-ai-service.ts's own 16384 -- this
// call has no proposedSections equivalent, just one flat matches array,
// so it has less room to run long.
const MAX_COMPLETION_TOKENS = 8192;

// lowercase/trim/collapse-whitespace/strip-trailing-punctuation -- this
// only needs to catch identical text (Tier 1 is deliberately narrow),
// not fuzzy overlap; Tier 2 is what handles genuine rewording.
export function normalizeDescriptionForMatch(description: string): string {
  return description
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "");
}

// A proposed item and a candidate sharing the exact same normalized
// description is matched with certainty, no AI judgment call needed --
// this is what makes the identical-document-recommit case (the
// production incident the old whole-document guard used to catch) safe
// with zero AI dependency. Deliberately only matches when a normalized
// description maps to EXACTLY one candidate: if the same normalized text
// is (legitimately) shared by 2+ existing line items already, picking
// one would be a guess, so those proposed items fall through to Tier 2
// instead -- same "don't force it" posture as
// vendor-match-ai-service.ts's own findPositionCodeMatches.
export function findExactDuplicates(
  proposedItems: ProposedItemForDuplicateCheck[],
  candidates: ExistingLineItemCandidate[],
): Map<number, ExistingLineItemCandidate> {
  const byNormalized = new Map<string, ExistingLineItemCandidate[]>();
  for (const candidate of candidates) {
    const key = normalizeDescriptionForMatch(candidate.description);
    if (!key) continue;
    byNormalized.set(key, [...(byNormalized.get(key) ?? []), candidate]);
  }

  const result = new Map<number, ExistingLineItemCandidate>();
  proposedItems.forEach((item, i) => {
    const key = normalizeDescriptionForMatch(item.description);
    if (!key) return;
    const matches = byNormalized.get(key);
    if (matches && matches.length === 1) result.set(i, matches[0]);
  });
  return result;
}

function buildProposedItemsBlock(items: ProposedItemForDuplicateCheck[]): string {
  return items
    .map((item, i) => {
      const qty = item.qty != null ? `${item.qty}${item.unit ? ` ${item.unit}` : ""}` : item.unit || "";
      return `${i}. ${item.description}${qty ? ` (${qty})` : ""}`;
    })
    .join("\n");
}

function buildCandidatesBlock(candidates: ExistingLineItemCandidate[]): string {
  return candidates
    .map((c, i) => {
      const section = c.sectionLabel ? ` [${c.sectionLabel}]` : "";
      const qty = c.qty != null ? `${c.qty}${c.unit ? ` ${c.unit}` : ""}` : c.unit || "";
      return `${i}. ${c.description}${section}${qty ? ` (${qty})` : ""}`;
    })
    .join("\n");
}

export interface RawLineItemDuplicateMatch {
  proposedIndex: number;
  candidateIndex: number | null;
  confidence: DuplicateMatchConfidence;
  reasoning: string;
}

// Separated from matchProposedLineItemsAgainstExisting below so it's
// directly testable without a live OpenAI call -- takes the model's raw
// response shape and maps indices back to real candidates, dropping any
// hallucinated/out-of-range candidateIndex rather than trusting it (same
// distrust-the-model posture as resolveVendorLineMatches). No forced
// one-winner-per-candidate dedup here -- see this file's own header
// comment for why that's a deliberate difference from
// vendor-match-ai-service.ts.
export function resolveDuplicateMatches(
  rawMatches: RawLineItemDuplicateMatch[],
  proposedItems: ProposedItemForDuplicateCheck[],
  candidates: ExistingLineItemCandidate[],
): LineItemDuplicateMatch[] {
  const rawByProposedIndex = new Map<number, RawLineItemDuplicateMatch>();
  for (const m of rawMatches) {
    if (!rawByProposedIndex.has(m.proposedIndex)) rawByProposedIndex.set(m.proposedIndex, m);
  }

  return proposedItems.map((_, i) => {
    const raw = rawByProposedIndex.get(i);
    // A hallucinated/out-of-range candidateIndex is dropped, not trusted.
    const candidate = raw?.candidateIndex != null ? candidates[raw.candidateIndex] : undefined;
    const existingLineItemId = raw?.candidateIndex != null && candidate ? candidate.id : null;
    return {
      existingLineItemId,
      confidence: raw?.confidence ?? null,
      reasoning: raw?.reasoning ?? null,
    };
  });
}

// opportunityId is for AI-usage tracking only (recordAiUsage); this
// function does no DB reads/writes of its own -- caller persists the
// result, same split as matchVendorQuoteLinesWithAi.
export async function matchProposedLineItemsAgainstExisting(
  proposedItems: ProposedItemForDuplicateCheck[],
  candidates: ExistingLineItemCandidate[],
  opportunityId: string,
  documentId: string | null = null,
  userId: string | null = null,
): Promise<LineItemDuplicateMatch[]> {
  if (proposedItems.length === 0) return [];

  const exactMatches = findExactDuplicates(proposedItems, candidates);

  // Tier-1-resolved proposed items are pulled out of what the AI sees --
  // already solved with certainty. Candidates are NOT reduced the same
  // way (unlike vendor-match's own claimedCandidateIds): a Tier-1-matched
  // candidate can still legitimately be the real duplicate target for a
  // different, still-unresolved proposed item.
  const aiIndexToOriginal: number[] = [];
  const aiProposedItems: ProposedItemForDuplicateCheck[] = [];
  proposedItems.forEach((item, i) => {
    if (exactMatches.has(i)) return;
    aiIndexToOriginal.push(i);
    aiProposedItems.push(item);
  });

  let aiMatches: LineItemDuplicateMatch[] = [];

  if (aiProposedItems.length === 0) {
    // Every proposed item resolved by Tier 1 -- nothing left for the AI
    // to do.
  } else if (candidates.length === 0) {
    // No existing line items at all (a version's first-ever import) --
    // nothing to compare against, no AI call needed, everything is
    // genuinely new.
    aiMatches = aiProposedItems.map(() => ({ existingLineItemId: null, confidence: null, reasoning: null }));
  } else {
    // Throws AiNotConfiguredError before any work -- same posture as
    // every other AI-proposal function in this app.
    const client = getOpenAiClient();

    const completion = await client.chat.completions.create({
      model: ADVANCED_MODEL,
      temperature: 0.2,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `PROPOSED ITEMS:\n${buildProposedItemsBlock(aiProposedItems)}\n\nEXISTING LINE ITEMS:\n${buildCandidatesBlock(candidates)}`,
        },
      ],
      response_format: { type: "json_schema", json_schema: DUPLICATE_MATCH_SCHEMA },
    });

    await recordAiUsage({
      userId,
      feature: "LINE_ITEM_DUPLICATE_MATCH",
      model: ADVANCED_MODEL,
      usage: completion.usage,
      documentId: documentId ?? undefined,
      opportunityId,
    });

    const choice = completion.choices[0];
    const content = choice?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response.");
    if (choice.finish_reason === "length") {
      throw new Error(
        "Matching this many proposed items against the estimate exceeded a single AI pass -- the response was cut off before finishing.",
      );
    }
    const parsed = JSON.parse(content) as { matches: RawLineItemDuplicateMatch[] };
    aiMatches = resolveDuplicateMatches(parsed.matches, aiProposedItems, candidates);
  }

  return proposedItems.map((item, i) => {
    const exact = exactMatches.get(i);
    if (exact) {
      return {
        existingLineItemId: exact.id,
        confidence: "high" as const,
        reasoning: "Exact match against an existing line item's description.",
      };
    }
    const aiIndex = aiIndexToOriginal.indexOf(i);
    return aiMatches[aiIndex];
  });
}
