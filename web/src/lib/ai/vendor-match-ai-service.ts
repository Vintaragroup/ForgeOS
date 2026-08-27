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

import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";

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
          },
          required: ["vendorLineIndex", "candidateIndex", "confidence", "reasoning"],
        },
      },
    },
    required: ["matches"],
  },
} as const;

const SYSTEM_PROMPT = `You are matching a vendor's own priced quote line items against a contractor's existing (currently unpriced) estimate line items for the same job -- both lists describe the same physical scope of work, but were written independently by different people using different conventions, so wording alone is often ambiguous.

Below you'll see:
- VENDOR LINES: every priced line item from the vendor's quote, numbered, each with its own unit/section code if the vendor's document uses one (e.g. "CAM-06", "BTH-04") and its price/quantity.
- CANDIDATE LINE ITEMS: every line item on the estimate this package covers, numbered, each with its own section label if grouped, and quantity/unit.

For EACH vendor line, decide which candidate (if any) it's actually pricing, using:
- Description similarity -- usually the most reliable signal.
- Price/quantity plausibility -- a vendor line's price and quantity should be a plausible match for the candidate's own quantity/unit.
- The vendor's own unit/section code and the candidate's own section label, WHEN THEY GIVE YOU A REAL HINT -- these are two independent naming schemes with no guaranteed correspondence, so don't force a match on code/label alone if the description doesn't support it.

Each candidate should be matched to at most one vendor line. When several vendor lines and several candidates share the exact same description with nothing else to distinguish them, do your best using price/quantity/order, but if you genuinely cannot tell them apart, leave the extras unmatched (confidence "low", candidateIndex null) rather than guessing -- a wrong auto-suggested price is worse than a visible "no match" that prompts a human to pick manually.

Return one entry per vendor line, using its exact vendorLineIndex.`;

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

function buildCandidatesBlock(candidates: MatchCandidate[]): string {
  return candidates
    .map((c, i) => {
      const section = c.sectionLabel ? ` [${c.sectionLabel}]` : "";
      const qty = c.qty != null ? `${c.qty}${c.unit ? ` ${c.unit}` : ""}` : c.unit || "";
      return `${i}. ${c.description}${section}${qty ? ` (${qty})` : ""}`;
    })
    .join("\n");
}

export interface RawVendorLineMatch {
  vendorLineIndex: number;
  candidateIndex: number | null;
  confidence: MatchConfidence;
  reasoning: string;
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
): Promise<VendorLineMatch[]> {
  if (vendorLines.length === 0) return [];
  if (candidates.length === 0) {
    return vendorLines.map((vendorLine) => ({ vendorLine, lineItemId: null, confidence: null, reasoning: null }));
  }

  // Throws AiNotConfiguredError before any work -- same posture as every
  // other AI-proposal function in this app.
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
        content: `VENDOR LINES:\n${buildVendorLinesBlock(vendorLines)}\n\nCANDIDATE LINE ITEMS:\n${buildCandidatesBlock(candidates)}`,
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
  const parsed = JSON.parse(content) as { matches: RawVendorLineMatch[] };
  return resolveVendorLineMatches(parsed.matches, vendorLines, candidates);
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
    return { vendorLine, lineItemId, confidence: raw?.confidence ?? null, reasoning: raw?.reasoning ?? null };
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
