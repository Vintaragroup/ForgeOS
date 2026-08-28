// Matches a vendor quote's own priced line items against a BidPackage's
// existing (unpriced) LineItems -- replaces the earlier Jaccard
// token-overlap + greedy assignment approach (vendor-match-service.ts,
// removed) after real-world testing confirmed it: a vendor quote and an
// estimate both routinely contain many near-identical lines ("Sleeper
// Floor" under 14 different vendor unit codes vs. "Sleeper Floor
// Required" under 3 different estimate sections), and a per-pair token
// formula with no global view has no way to know it's guessing.
//
// Same shape as scope-coverage-service.ts's runScopeCoverageAnalysis:
// one AI call given BOTH full lists at once, so the model can reason
// jointly (this vendor line vs. all candidates, not just its single
// highest Jaccard score) using ADVANCED_MODEL -- see openai-client.ts's
// own comment for why this class of problem needs it.
//
// This does NOT solve the underlying "CAM-06 vs. Section 203" mapping
// problem in general -- those remain two independent naming schemes with
// no shared vocabulary, and no model can invent a correspondence that
// isn't in the text. What it DOES do: use price/quantity plausibility
// and whatever real signal exists, and -- same posture as the old
// service's own header comment -- leave a line unmatched rather than
// guess when several vendor lines and candidates are truly
// indistinguishable. A wrong auto-suggested price is worse than a
// visible "no match" that prompts a human to pick manually.
//
// Same call also proposes NEW estimate sections (see ProposedVendorSection
// below) for a vendor grouping that reads as a real cost category (e.g.
// "One Time Service Costs") rather than an opaque positional code (e.g.
// "CAM-06") and has nothing on the estimate corresponding to it -- a
// distinct judgment from candidate matching, bundled into this same call
// rather than a second full-document AI pass, since it needs the same
// joint view of every vendor line and every existing section to decide.
// Bid-package-actions.ts's commit/dismiss actions are what actually turn
// a proposal into a real section -- this function only proposes.

import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { significantTokens } from "@/lib/catalog-match-service";

export interface VendorQuoteLine {
  description: string;
  unit: string | null;
  qty: number | null;
  unitPrice: number;
  totalPrice: number | null;
  sourceQuote: string;
  // The vendor's own unit/section header this line falls under in the
  // source document (e.g. "CAM-06", "BTH-04") -- null when the document
  // has no such per-item grouping. Shown to the model as context (it may
  // help distinguish otherwise-identical lines) AND to the human reviewer
  // in the match UI, but never treated as a deterministic key.
  unitCode: string | null;
  // Real PDF page number this line's sourceQuote was found on (resolved
  // via text-extraction.ts's locateQuotePage in vendor-quote-service.ts,
  // same lazy PDF-only pattern as scope-coverage-service.ts's
  // resolveCoverageGaps) -- null for non-PDF documents or a quote that
  // couldn't be located. Feeds citation.ts's citationHref so a bare
  // description like "Test and adjust" is one click away from the real
  // page and its surrounding context.
  pageNumber: number | null;
}

export type MatchConfidence = "high" | "medium" | "low";

export interface VendorLineMatch {
  vendorLine: VendorQuoteLine;
  lineItemId: string | null;
  confidence: MatchConfidence | null;
  // A short, human-readable reason for this match (or non-match) -- shown
  // in the review UI so a reviewer can sanity-check the AI's reasoning
  // instead of just trusting a bare assignment.
  reasoning: string | null;
  // True when the vendor's OWN description doesn't give enough
  // information to know what physical item/scope this line is even
  // pricing -- independent of whether it matches an estimate line item.
  // A distinct judgment from confidence: a line can be clearly described
  // but genuinely unmatched (low confidence, needsClarification false),
  // or matched with high confidence to the wrong thing precisely because
  // its description was too vague to catch (needsClarification true).
  // Surfaced as a flag a reviewer can act on by asking the bidder, not
  // guessed past.
  needsClarification: boolean;
  // The candidate id this vendor line was matched to BEFORE dedup, kept
  // even when lineItemId above was nulled out for losing a
  // duplicate-match tiebreak against another vendor line pointing at the
  // same candidate (see resolveVendorLineMatches below). Powers two
  // things: pre-selecting this candidate as a starting suggestion in the
  // "Matched to" dropdown even when there's no confident winner, and
  // grouping vendor lines by shared target for a bulk-apply action --
  // both need the pre-dedup id, which otherwise has nowhere to live once
  // dedup discards it.
  suggestedLineItemId: string | null;
}

export interface MatchCandidate {
  id: string;
  description: string;
  // EstimateSection.groupLabel ?? name -- the estimate's own structural
  // context for this line item, same as unitCode above: real signal when
  // it happens to help, never a guaranteed key.
  sectionLabel: string | null;
  qty: number | null;
  unit: string | null;
  // LineItem.positionCode -- when this exactly matches a vendor line's
  // own unitCode (case/whitespace-insensitive), that pair is matched
  // deterministically below, before the AI ever sees either side. See
  // findPositionCodeMatches and LineItem.positionCode's own schema
  // comment for why this is the one signal strong enough to skip the
  // "two independent naming schemes" judgment call entirely.
  positionCode: string | null;
}

// Reuses ProposedLineItem's fixed lineType vocabulary from
// scope-line-item-service.ts, since a committed proposal creates real
// LineItem rows the same way that flow does.
export type ProposedLineType = "MATERIAL" | "LABOR" | "FEE";

export interface ProposedVendorSection {
  // The section name to create, as the vendor's own document names the
  // category (e.g. "One Time Service Costs") -- shown as-is, not
  // editable before commit (see bid-package-actions.ts's commit action).
  name: string;
  lineType: ProposedLineType;
  // Why this deserves a new section -- e.g. what real category it is and
  // why nothing on the estimate already covers it.
  reasoning: string;
  // Indices into the SAME vendorLines array (and therefore the same
  // positions in the persisted matches array) this proposal was resolved
  // against -- kept as indices, not resolved VendorQuoteLine objects,
  // specifically so a caller can look them up again in the persisted
  // matchResult at commit time and know EXACTLY which matches entry each
  // newly created LineItem corresponds to. Resolving to full objects here
  // instead would silently break that correspondence for two vendor
  // lines that happen to share an identical description/sourceQuote (a
  // real case in this app's own fixture data -- multiple "Non Slip
  // Paint" lines under different CAM codes).
  vendorLineIndices: number[];
}

const REASONING_DESCRIPTION =
  "Under 100 characters: the specific reason for this match (or non-match) -- what distinguished it from other candidates.";

export const MATCH_SCHEMA = {
  name: "vendor_line_matches",
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
            vendorLineIndex: {
              type: "integer",
              description: "The vendor line's own index, exactly as numbered in the VENDOR LINES list above.",
            },
            candidateIndex: {
              type: ["integer", "null"],
              description:
                "The matched candidate's own index, exactly as numbered in the CANDIDATE LINE ITEMS list above, or null if this vendor line doesn't clearly match any candidate.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "How confident you are in this match. \"low\" (or a null candidateIndex) means a human should review it.",
            },
            reasoning: { type: "string", description: REASONING_DESCRIPTION },
            needsClarification: {
              type: "boolean",
              description:
                "True if the vendor line's OWN description doesn't state enough about what it actually is to place it confidently, regardless of whether a candidate matched (e.g. a bare label like \"Test and adjust\" or \"Miscellaneous\" with no object stated). False for a clearly-described line even if it has no matching candidate.",
            },
          },
          required: ["vendorLineIndex", "candidateIndex", "confidence", "reasoning", "needsClarification"],
        },
      },
      proposedSections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: {
              type: "string",
              description: "The new section name, exactly as the vendor's own document names this category (e.g. \"One Time Service Costs\").",
            },
            lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"], description: "The best-fitting type for the line items this section would hold." },
            reasoning: {
              type: "string",
              description: "Under 150 characters: what real category this is, and why nothing in EXISTING SECTIONS already covers it.",
            },
            vendorLineIndices: {
              type: "array",
              items: { type: "integer" },
              description: "The vendorLineIndex of every vendor line that belongs under this proposed section -- every line sharing this real category, not one proposal per line.",
            },
          },
          required: ["name", "lineType", "reasoning", "vendorLineIndices"],
        },
      },
    },
    required: ["matches", "proposedSections"],
  },
} as const;

const SYSTEM_PROMPT = `You are matching a vendor's own priced quote line items against a contractor's existing (currently unpriced) estimate line items for the same job -- both lists describe the same physical scope of work, but were written independently by different people using different conventions, so wording alone is often ambiguous.

Below you'll see:
- VENDOR LINES: every priced line item from the vendor's quote, numbered, each with its own unit/section code if the vendor's document uses one (e.g. "CAM-06", "BTH-04") and its price/quantity.
- CANDIDATE LINE ITEMS: every line item on the estimate this package covers, numbered, each with its own section label if grouped, and quantity/unit.
- EXISTING SECTIONS: every distinct section label already on the estimate.

For EACH vendor line, decide which candidate (if any) it's actually pricing, using:
- Description similarity -- usually the most reliable signal.
- Price/quantity plausibility -- a vendor line's price and quantity should be a plausible match for the candidate's own quantity/unit.
- The vendor's own unit/section code and the candidate's own section label, WHEN THEY GIVE YOU A REAL HINT -- these are two independent naming schemes with no guaranteed correspondence, so don't force a match on code/label alone if the description doesn't support it.

Each candidate should be matched to at most one vendor line. When several vendor lines and several candidates share the exact same description with nothing else to distinguish them, do your best using price/quantity/order, but if you genuinely cannot tell them apart, leave the extras unmatched (confidence "low", candidateIndex null) rather than guessing -- a wrong auto-suggested price is worse than a visible "no match" that prompts a human to pick manually.

Separately from matching, set needsClarification true for a vendor line whose OWN description doesn't state enough to know what it actually is -- a bare service/action label with no object ("Test and adjust", "Miscellaneous", "Adjustment") that could mean almost anything without more context from the vendor. This is about the description's own clarity, not whether it matched: a well-described line with no matching candidate is needsClarification false (it's just genuinely not on this estimate); a vague line is needsClarification true even if you found a plausible candidate for it, because the match itself is only a guess at what the vendor meant.

Also propose new sections: some vendor lines are grouped under a header that is a REAL cost category (e.g. "One Time Service Costs", "General Conditions") rather than an opaque positional/internal code (e.g. "CAM-06", "BTH-04" -- codes like these are never worth proposing a section for, even when their lines are unmatched). When a real category groups vendor lines that don't already have a confident match, and nothing in EXISTING SECTIONS already corresponds to that category, propose ONE new section covering every vendor line in that category (not one proposal per line). Skip this entirely if the category already has a clear home in EXISTING SECTIONS, or if the grouping is just a positional code.

Return one matches entry per vendor line, using its exact vendorLineIndex. Return an empty proposedSections array if nothing qualifies.`;

// Same ceiling and truncation guard as vendor-quote-service.ts's own
// extraction call -- a full-package match response (one entry per vendor
// line, up to ~200+ for a real large quote) can be long enough to hit
// gpt-4o's real output ceiling.
const MAX_COMPLETION_TOKENS = 16384;

function buildVendorLinesBlock(vendorLines: VendorQuoteLine[]): string {
  return vendorLines
    .map((line, i) => {
      const code = line.unitCode ? `[${line.unitCode}] ` : "";
      const qty = line.qty != null ? `${line.qty}${line.unit ? ` ${line.unit}` : ""}` : line.unit || "";
      return `${i}. ${code}${line.description} -- $${line.unitPrice}${qty ? ` (${qty})` : ""}`;
    })
    .join("\n");
}

// A candidate reaching this function already had no exact position-code
// match (see findPositionCodeMatches below -- exact matches are resolved
// deterministically and never reach the AI), so a code shown here is
// necessarily a NEAR miss (different formatting, typo, etc.) -- still
// worth surfacing as a weak hint alongside sectionLabel, never a
// guaranteed key.
function buildCandidatesBlock(candidates: MatchCandidate[]): string {
  return candidates
    .map((c, i) => {
      const code = c.positionCode ? ` [${c.positionCode}]` : "";
      const section = c.sectionLabel ? ` [${c.sectionLabel}]` : "";
      const qty = c.qty != null ? `${c.qty}${c.unit ? ` ${c.unit}` : ""}` : c.unit || "";
      return `${i}. ${c.description}${code}${section}${qty ? ` (${qty})` : ""}`;
    })
    .join("\n");
}

// Deduplicated section labels already on the estimate -- lets the model
// check "does a section like this already exist?" before proposing a new
// one, without re-deriving it from every individual candidate line. Also
// reused as a deterministic post-filter in resolveProposedVendorSections
// below -- the model is TOLD about these labels in the prompt, but proven
// live not to reliably honor "skip if it already exists," so this same
// set is used again after the fact rather than trusted on the model's
// word alone.
function existingSectionLabels(candidates: MatchCandidate[]): Set<string> {
  return new Set(candidates.map((c) => c.sectionLabel).filter((label): label is string => !!label));
}

function buildExistingSectionsBlock(labels: Set<string>): string {
  return labels.size > 0 ? Array.from(labels).map((label) => `- ${label}`).join("\n") : "(none)";
}

export interface RawVendorLineMatch {
  vendorLineIndex: number;
  candidateIndex: number | null;
  confidence: MatchConfidence;
  reasoning: string;
  needsClarification: boolean;
}

export interface RawProposedVendorSection {
  name: string;
  lineType: ProposedLineType;
  reasoning: string;
  vendorLineIndices: number[];
}

export interface VendorMatchResult {
  matches: VendorLineMatch[];
  proposedSections: ProposedVendorSection[];
}

// A vendor line and a candidate sharing the exact same position code
// (case/whitespace-insensitive -- "cam-01" and "CAM-01" are the same
// code) is matched with certainty, no AI judgment call needed. This is
// the one signal strong enough to bridge two documents with genuinely no
// shared vocabulary otherwise (a vendor's own "CAM-06" vs. a client
// RFP's "Section 203 - Main Far Left Slash Camera") -- see
// LineItem.positionCode's own schema comment for where this code comes
// from. Deliberately only auto-matches when a code maps to EXACTLY one
// candidate: if the same code is (incorrectly) reused across multiple
// candidates, that's not a safe deterministic call, so those lines fall
// through to the AI/manual-review path instead, same "don't force it"
// posture as everything else in this file.
export function findPositionCodeMatches(
  vendorLines: VendorQuoteLine[],
  candidates: MatchCandidate[],
): Map<number, MatchCandidate> {
  const byCode = new Map<string, MatchCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.positionCode) continue;
    const key = candidate.positionCode.trim().toUpperCase();
    if (!key) continue;
    byCode.set(key, [...(byCode.get(key) ?? []), candidate]);
  }

  const result = new Map<number, MatchCandidate>();
  vendorLines.forEach((line, i) => {
    if (!line.unitCode) return;
    const key = line.unitCode.trim().toUpperCase();
    if (!key) return;
    const matches = byCode.get(key);
    if (matches && matches.length === 1) result.set(i, matches[0]);
  });
  return result;
}

function codeMatchToVendorLineMatch(vendorLine: VendorQuoteLine, candidate: MatchCandidate): VendorLineMatch {
  return {
    vendorLine,
    lineItemId: candidate.id,
    confidence: "high",
    reasoning: `Matched by shared position code "${vendorLine.unitCode}".`,
    needsClarification: false,
    suggestedLineItemId: candidate.id,
  };
}

// documentId/opportunityId are for AI-usage tracking only (recordAiUsage);
// this function does no DB reads/writes of its own -- caller persists the
// result, same split as resolveCoverageGaps/runScopeCoverageAnalysis.
export async function matchVendorQuoteLinesWithAi(
  vendorLines: VendorQuoteLine[],
  candidates: MatchCandidate[],
  opportunityId: string,
  documentId: string | null = null,
  userId: string | null = null,
): Promise<VendorMatchResult> {
  if (vendorLines.length === 0) return { matches: [], proposedSections: [] };

  const codeMatches = findPositionCodeMatches(vendorLines, candidates);
  const claimedCandidateIds = new Set(Array.from(codeMatches.values(), (c) => c.id));

  // Code-matched vendor lines and the candidates they claimed are pulled
  // out of what the AI sees entirely -- both because they're already
  // solved with certainty, and because leaving a claimed candidate in
  // the pool risks the AI separately (and wrongly) guessing some OTHER,
  // textually-ambiguous vendor line onto it.
  const aiIndexToOriginal: number[] = [];
  const aiVendorLines: VendorQuoteLine[] = [];
  vendorLines.forEach((line, i) => {
    if (codeMatches.has(i)) return;
    aiIndexToOriginal.push(i);
    aiVendorLines.push(line);
  });
  const aiCandidates = candidates.filter((c) => !claimedCandidateIds.has(c.id));
  // From the FULL candidate list, not aiCandidates -- a section whose
  // every OTHER line item happened to get position-code-matched away
  // must still count as "already exists" to the model, or it would
  // wrongly re-propose a section that's already on the estimate.
  const sectionLabels = existingSectionLabels(candidates);

  let aiMatches: VendorLineMatch[] = [];
  let proposedSections: ProposedVendorSection[] = [];

  if (aiVendorLines.length === 0) {
    // Every vendor line resolved by position code -- nothing left for
    // the AI to do.
  } else if (aiCandidates.length === 0) {
    // Never called the AI, so clarity of the description was never
    // judged -- false, not a guess, same "we don't know" posture as
    // confidence: null here. No existing sections to compare against
    // either, so no section proposals.
    aiMatches = aiVendorLines.map((vendorLine) => ({
      vendorLine,
      lineItemId: null,
      confidence: null,
      reasoning: null,
      needsClarification: false,
      suggestedLineItemId: null,
    }));
  } else {
    // Throws AiNotConfiguredError before any work -- same posture as
    // every other AI-proposal function in this app.
    const client = getOpenAiClient();

    const completion = await client.chat.completions.create({
      model: ADVANCED_MODEL,
      // Low, not zero -- a structured judgment call over a fixed shape, not
      // creative writing, same reasoning as this app's other ADVANCED_MODEL
      // calls.
      temperature: 0.2,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `VENDOR LINES:\n${buildVendorLinesBlock(aiVendorLines)}\n\nCANDIDATE LINE ITEMS:\n${buildCandidatesBlock(aiCandidates)}\n\nEXISTING SECTIONS:\n${buildExistingSectionsBlock(sectionLabels)}`,
        },
      ],
      response_format: { type: "json_schema", json_schema: MATCH_SCHEMA },
    });

    await recordAiUsage({
      userId,
      feature: "VENDOR_LINE_MATCH",
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
        "Matching this many vendor lines against the estimate exceeded a single AI pass -- the response was cut off before finishing.",
      );
    }
    const parsed = JSON.parse(content) as { matches: RawVendorLineMatch[]; proposedSections: RawProposedVendorSection[] };
    aiMatches = resolveVendorLineMatches(parsed.matches, aiVendorLines, aiCandidates);
    // vendorLineIndices in the model's response are indexed against
    // aiVendorLines (the reduced list it was actually shown) -- translated
    // back to real, original vendorLines indices before this leaves the
    // function, so every downstream caller (bid-package-actions.ts) only
    // ever deals in original indices.
    proposedSections = resolveProposedVendorSections(parsed.proposedSections, aiMatches, sectionLabels).map(
      (proposal) => ({
        ...proposal,
        vendorLineIndices: proposal.vendorLineIndices.map((i) => aiIndexToOriginal[i]),
      }),
    );
  }

  const matches = vendorLines.map((vendorLine, i) => {
    const codeMatch = codeMatches.get(i);
    if (codeMatch) return codeMatchToVendorLineMatch(vendorLine, codeMatch);
    const aiIndex = aiIndexToOriginal.indexOf(i);
    return aiMatches[aiIndex];
  });

  return { matches, proposedSections };
}

// Separated from matchVendorQuoteLinesWithAi above so it's directly
// testable without a live OpenAI call -- takes the model's raw response
// shape and does everything after it: map indices back to real
// candidates, drop hallucinated/out-of-range indices, and deduplicate any
// candidate the model (despite being told not to) assigned to more than
// one vendor line. Mirrors why resolveCoverageGaps is a separate,
// independently-testable function from runScopeCoverageAnalysis in
// scope-coverage-service.ts.
export function resolveVendorLineMatches(
  rawMatches: RawVendorLineMatch[],
  vendorLines: VendorQuoteLine[],
  candidates: MatchCandidate[],
): VendorLineMatch[] {
  const rawByVendorIndex = new Map<number, RawVendorLineMatch>();
  for (const m of rawMatches) {
    if (!rawByVendorIndex.has(m.vendorLineIndex)) rawByVendorIndex.set(m.vendorLineIndex, m);
  }

  const provisional = vendorLines.map((vendorLine, i) => {
    const raw = rawByVendorIndex.get(i);
    // A hallucinated/out-of-range candidateIndex is dropped, not trusted
    // -- same posture as resolveCoverageGaps dropping a hallucinated
    // filename in scope-coverage-service.ts.
    const candidate = raw?.candidateIndex != null ? candidates[raw.candidateIndex] : undefined;
    const lineItemId = raw?.candidateIndex != null && candidate ? candidate.id : null;
    return {
      vendorLine,
      lineItemId,
      confidence: raw?.confidence ?? null,
      reasoning: raw?.reasoning ?? null,
      needsClarification: raw?.needsClarification ?? false,
      suggestedLineItemId: lineItemId,
    };
  });

  // Defense in depth: the prompt asks for at-most-one-vendor-line per
  // candidate, but structured output doesn't guarantee it. If the model
  // assigned the same candidate twice anyway, keep only the
  // highest-confidence claim and null out the rest rather than silently
  // letting two vendor prices land on one line item.
  const confidenceRank: Record<MatchConfidence, number> = { high: 3, medium: 2, low: 1 };
  const winnerIndexByLineItemId = new Map<string, number>();
  provisional.forEach((match, i) => {
    if (!match.lineItemId) return;
    const currentWinner = winnerIndexByLineItemId.get(match.lineItemId);
    if (currentWinner === undefined) {
      winnerIndexByLineItemId.set(match.lineItemId, i);
      return;
    }
    const currentRank = confidenceRank[provisional[currentWinner].confidence ?? "low"];
    const challengerRank = confidenceRank[match.confidence ?? "low"];
    if (challengerRank > currentRank) winnerIndexByLineItemId.set(match.lineItemId, i);
  });

  return provisional.map((match, i) => {
    if (!match.lineItemId) return match;
    const isWinner = winnerIndexByLineItemId.get(match.lineItemId) === i;
    return isWinner ? match : { ...match, lineItemId: null, confidence: "low" as const };
  });
}

// Same testable-without-a-live-call split as resolveVendorLineMatches --
// validates each proposal's vendorLineIndices against the real vendor
// line count, dropping any hallucinated/out-of-range index rather than
// trusting it (kept as indices, not resolved objects -- see
// ProposedVendorSection's own comment on why), and drops a proposal
// entirely if none of its indices were valid (nothing real left to
// create a section for).
//
// Two deterministic backstops, added after a live production incident
// where the model re-proposed "One Time Service Costs" on a re-extract
// even though it already existed as a real section with real, already-
// matched line items -- despite the prompt telling it not to (see
// SYSTEM_PROMPT and EXISTING SECTIONS). The model's own judgment alone
// proved unreliable, so this no longer trusts it on either count:
//   1. Drop any vendorLineIndex whose match already resolved to a real
//      lineItemId -- a proposal should only ever cover vendor lines that
//      don't already have a confident match (this mirrors what the
//      prompt already asks for, just enforced in code instead of hoped
//      for).
//   2. Drop the whole proposal if its name collides (case/whitespace
//      insensitive) with a section that already exists on the estimate.
// Neither backstop is a substitute for commitProposedVendorSectionAction
// ALSO being idempotent (see its own header comment) -- this filter
// reduces how often a stale proposal is even offered, the commit action
// is what guarantees clicking "Create section" can never duplicate real
// priced line items even if a proposal slips through anyway.
export function resolveProposedVendorSections(
  raw: RawProposedVendorSection[],
  matches: VendorLineMatch[],
  existingSectionNames: Set<string>,
): ProposedVendorSection[] {
  const existingNamesLower = new Set(Array.from(existingSectionNames, (n) => n.trim().toLowerCase()));
  return raw
    .map((proposal) => ({
      name: proposal.name,
      lineType: proposal.lineType,
      reasoning: proposal.reasoning,
      vendorLineIndices: proposal.vendorLineIndices.filter(
        (i) => i >= 0 && i < matches.length && !matches[i].lineItemId,
      ),
    }))
    .filter(
      (proposal) =>
        proposal.vendorLineIndices.length > 0 && !existingNamesLower.has(proposal.name.trim().toLowerCase()),
    );
}

// Deterministic, non-AI fallback for the "Matched to" dropdown when the
// holistic AI pass found genuinely no candidate at all for a vendor line
// (both lineItemId and suggestedLineItemId are null) -- confirmed live
// that reviewers were having to hand-search a 30-40+ item dropdown for
// these with zero starting point. Reuses catalog-match-service.ts's own
// tokenizer (its header comment already anticipated this exact reuse)
// and ports the symmetric Jaccard scorer the old vendor-match-service.ts
// used before the AI matcher replaced it -- right tool for this specific
// job, since a vendor line ("Sleeper Floor") and a candidate line item
// ("Sleeper Floor Required") are both short, similarly-shaped phrases
// needing "how much of EITHER side's vocabulary is shared," not
// catalog-match-service's own asymmetric containment (built for a short
// canonical catalog name against a long narrative description).
//
// This is ONLY a UI default to save a manual search -- it never sets
// confidence/needsClarification, never feeds proposedSections or
// bulkGroups, and a human still has to click Apply. A wrong pre-filled
// dropdown selection a reviewer catches and corrects is harmless; the
// AI's own real judgment (confidence, reasoning) is left completely
// alone for every line this fallback isn't even reached for.
const FALLBACK_MIN_SCORE = 0.34;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function findClosestCandidateId(
  description: string,
  candidates: { id: string; description: string }[],
): string | null {
  const vendorTokens = new Set(significantTokens(description));
  if (vendorTokens.size === 0) return null;

  let bestId: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = jaccard(vendorTokens, new Set(significantTokens(candidate.description)));
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.id;
    }
  }
  return bestScore >= FALLBACK_MIN_SCORE ? bestId : null;
}
