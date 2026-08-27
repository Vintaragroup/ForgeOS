import { describe, expect, it } from "vitest";
import { matchVendorQuoteLines, type VendorQuoteLine } from "@/lib/vendor-match-service";

function vendorLine(description: string, unitPrice: number): VendorQuoteLine {
  return { description, unit: null, qty: 1, unitPrice, totalPrice: unitPrice, sourceQuote: description, unitCode: null };
}

describe("matchVendorQuoteLines", () => {
  // Real fixture pair from the ShowRig quote this feature was built
  // for: CAM-06's "Sleeper Floor" line ($840) against the existing
  // "Sleeper Floor Required" scope line item already on the estimate.
  it("matches a real vendor line against its corresponding line item", () => {
    const [match] = matchVendorQuoteLines(
      [vendorLine("Sleeper Floor", 840)],
      [{ id: "li-1", description: "Sleeper Floor Required" }],
    );
    expect(match.lineItemId).toBe("li-1");
    expect(match.score).toBeGreaterThan(0.34);
  });

  // Same quote, a genuinely unrelated line item -- sharing zero real
  // vocabulary must stay unmatched, not guessed at.
  it("does not match an unrelated vendor line", () => {
    const [match] = matchVendorQuoteLines(
      [vendorLine("Guardrail (Adjustable Height)", 425)],
      [{ id: "li-1", description: "Sleeper Floor Required" }],
    );
    expect(match.lineItemId).toBeNull();
    expect(match.score).toBeNull();
  });

  it("assigns each candidate to at most one vendor line, preferring the higher score", () => {
    const matches = matchVendorQuoteLines(
      [vendorLine("Sleeper Floor", 840), vendorLine("Sleeper Floor Required for platform", 900)],
      [{ id: "li-1", description: "Sleeper Floor Required" }],
    );
    // The second line shares more vocabulary with the candidate, so it
    // should win the claim; the first is left unmatched rather than
    // both pointing at the same LineItem.
    expect(matches[1].lineItemId).toBe("li-1");
    expect(matches[0].lineItemId).toBeNull();
  });

  it("returns no matches when there are no candidates", () => {
    const matches = matchVendorQuoteLines([vendorLine("Sleeper Floor", 840)], []);
    expect(matches).toEqual([{ vendorLine: expect.any(Object), lineItemId: null, score: null }]);
  });

  it("returns an empty array when there are no vendor lines", () => {
    expect(matchVendorQuoteLines([], [{ id: "li-1", description: "Sleeper Floor Required" }])).toEqual([]);
  });
});
