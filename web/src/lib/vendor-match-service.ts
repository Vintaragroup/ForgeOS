// Matches a vendor quote's own priced line items against a BidPackage's
// existing (unpriced) LineItems -- deliberately NOT reusing
// catalog-match-service.ts's matchDescription, even though both solve
// "does this text refer to that text." matchDescription is asymmetric
// containment (every one of the CANDIDATE's words must appear in the
// query), correct for a short canonical catalog name against a long
// narrative line description, but wrong here: a vendor quote line
// ("Sleeper Floor") and a bid-package line item ("Sleeper Floor
// Required") are both short, similarly-shaped phrases, so this needs
// symmetric overlap instead -- how much of EITHER side's real vocabulary
// is shared, not whether one side's vocabulary is a strict subset of the
// other's.
//
// A wrong auto-applied vendor price is worse than a visible "no match"
// that prompts review -- same posture as catalog-match-service.ts's own
// header comment. Below MIN_MATCH_SCORE, or once a vendor line/candidate
// is already claimed by a stronger pairing, a line stays unmatched
// rather than guessed at.

import { significantTokens } from "@/lib/catalog-match-service";

export interface VendorQuoteLine {
  description: string;
  unit: string | null;
  qty: number | null;
  unitPrice: number;
  totalPrice: number | null;
  sourceQuote: string;
}

export interface VendorLineMatch {
  vendorLine: VendorQuoteLine;
  lineItemId: string | null;
  score: number | null;
}

// Tuned against the real ShowRig quote this feature was built for:
// "Sleeper Floor" (vendor) vs. "Sleeper Floor Required" (existing line
// item) scores 2/3 ≈ 0.667, comfortably above; "Guardrail (Adjustable
// Height)" against the same candidate shares no vocabulary at all and
// scores 0. See vendor-match-service.test.ts for both as fixtures.
const MIN_MATCH_SCORE = 0.34;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// Greedy one-to-one assignment over every (vendorLine, candidate) pair,
// highest score first -- a vendor quote and a bid package are each
// expected to describe roughly the same real items once, so letting one
// LineItem soak up two vendor lines (or vice versa) is almost always
// wrong. A vendor line or candidate already claimed by a stronger
// pairing is skipped, not reused.
export function matchVendorQuoteLines(
  vendorLines: VendorQuoteLine[],
  candidates: { id: string; description: string }[],
): VendorLineMatch[] {
  const candidateTokens = candidates.map((c) => ({ id: c.id, tokens: new Set(significantTokens(c.description)) }));

  const scoredPairs: { vendorIndex: number; candidateId: string; score: number }[] = [];
  vendorLines.forEach((line, vendorIndex) => {
    const vendorTokens = new Set(significantTokens(line.description));
    for (const candidate of candidateTokens) {
      const score = jaccard(vendorTokens, candidate.tokens);
      if (score >= MIN_MATCH_SCORE) scoredPairs.push({ vendorIndex, candidateId: candidate.id, score });
    }
  });
  scoredPairs.sort((a, b) => b.score - a.score);

  const claimedVendorIndexes = new Set<number>();
  const claimedCandidateIds = new Set<string>();
  const bestMatchByVendorIndex = new Map<number, { candidateId: string; score: number }>();
  for (const pair of scoredPairs) {
    if (claimedVendorIndexes.has(pair.vendorIndex) || claimedCandidateIds.has(pair.candidateId)) continue;
    claimedVendorIndexes.add(pair.vendorIndex);
    claimedCandidateIds.add(pair.candidateId);
    bestMatchByVendorIndex.set(pair.vendorIndex, { candidateId: pair.candidateId, score: pair.score });
  }

  return vendorLines.map((vendorLine, vendorIndex) => {
    const match = bestMatchByVendorIndex.get(vendorIndex);
    return { vendorLine, lineItemId: match?.candidateId ?? null, score: match?.score ?? null };
  });
}
