import { describe, expect, it } from "vitest";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  MATCH_SCHEMA,
  matchVendorQuoteLinesWithAi,
  resolveVendorLineMatches,
  type MatchCandidate,
  type RawVendorLineMatch,
  type VendorQuoteLine,
} from "@/lib/ai/vendor-match-ai-service";

function vendorLine(description: string, unitPrice: number, unitCode: string | null = null): VendorQuoteLine {
  return { description, unit: null, qty: null, unitPrice, totalPrice: null, sourceQuote: description, unitCode };
}

function candidate(id: string, description: string, sectionLabel: string | null = null): MatchCandidate {
  return { id, description, sectionLabel, qty: null, unit: null };
}

describe("matchVendorQuoteLinesWithAi", () => {
  it("returns an empty array with no vendor lines, before ever touching the OpenAI client", async () => {
    const matches = await matchVendorQuoteLinesWithAi([], [candidate("li-1", "Sleeper Floor Required")], "opp-1");
    expect(matches).toEqual([]);
  });

  it("returns every vendor line unmatched, with no OpenAI call, when there are no candidates", async () => {
    const lines = [vendorLine("Sleeper Floor", 840)];
    const matches = await matchVendorQuoteLinesWithAi(lines, [], "opp-1");
    expect(matches).toEqual([{ vendorLine: lines[0], lineItemId: null, confidence: null, reasoning: null }]);
  });

  it("throws AiNotConfiguredError once there's real work to do -- .env.test deliberately has no OPENAI_API_KEY", async () => {
    await expect(
      matchVendorQuoteLinesWithAi(
        [vendorLine("Sleeper Floor", 840)],
        [candidate("li-1", "Sleeper Floor Required")],
        "opp-1",
      ),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe("resolveVendorLineMatches", () => {
  // Real fixture pair from the ShowRig quote this feature was built for.
  it("maps a raw candidateIndex back to the real candidate id", () => {
    const lines = [vendorLine("Sleeper Floor", 840, "CAM-06")];
    const candidates = [candidate("li-1", "Sleeper Floor Required", "Section 203")];
    const raw: RawVendorLineMatch[] = [
      { vendorLineIndex: 0, candidateIndex: 0, confidence: "high", reasoning: "Same item, matching price." },
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches).toEqual([
      { vendorLine: lines[0], lineItemId: "li-1", confidence: "high", reasoning: "Same item, matching price." },
    ]);
  });

  it("leaves a vendor line unmatched when the model returns a null candidateIndex", () => {
    const lines = [vendorLine("Guardrail (Adjustable Height)", 425)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [
      { vendorLineIndex: 0, candidateIndex: null, confidence: "low", reasoning: "No corresponding scope item." },
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[0].lineItemId).toBeNull();
  });

  it("drops a hallucinated/out-of-range candidateIndex instead of crashing or trusting it", () => {
    const lines = [vendorLine("Sleeper Floor", 840)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [{ vendorLineIndex: 0, candidateIndex: 7, confidence: "high", reasoning: "x" }];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[0].lineItemId).toBeNull();
  });

  it("leaves a vendor line unmatched (with null confidence/reasoning) when the model omits it entirely", () => {
    const lines = [vendorLine("Sleeper Floor", 840), vendorLine("Guardrail", 425)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    // Model only addressed vendor line 0, skipping line 1 -- a truncated
    // or incomplete response shouldn't crash the mapping.
    const raw: RawVendorLineMatch[] = [{ vendorLineIndex: 0, candidateIndex: 0, confidence: "high", reasoning: "x" }];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[1]).toEqual({ vendorLine: lines[1], lineItemId: null, confidence: null, reasoning: null });
  });

  it("keeps only the highest-confidence claim when the model assigns the same candidate twice", () => {
    const lines = [vendorLine("Sleeper Floor", 840), vendorLine("Sleeper Floor Required for platform", 900)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [
      { vendorLineIndex: 0, candidateIndex: 0, confidence: "medium", reasoning: "Plausible match." },
      { vendorLineIndex: 1, candidateIndex: 0, confidence: "high", reasoning: "Stronger description overlap." },
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[1].lineItemId).toBe("li-1");
    expect(matches[0].lineItemId).toBeNull();
    expect(matches[0].confidence).toBe("low");
  });

  it("returns one entry per vendor line, in vendor-line order, regardless of raw entry order", () => {
    const lines = [vendorLine("A", 1), vendorLine("B", 2), vendorLine("C", 3)];
    const raw: RawVendorLineMatch[] = [
      { vendorLineIndex: 2, candidateIndex: null, confidence: "low", reasoning: "x" },
      { vendorLineIndex: 0, candidateIndex: null, confidence: "low", reasoning: "x" },
    ];

    const matches = resolveVendorLineMatches(raw, lines, []);

    expect(matches.map((m) => m.vendorLine.description)).toEqual(["A", "B", "C"]);
  });
});

describe("MATCH_SCHEMA", () => {
  it("is a strict JSON schema with every match field required -- proves the shape is actually wired into the request, not just documented in the type", () => {
    expect(MATCH_SCHEMA.strict).toBe(true);
    expect(MATCH_SCHEMA.schema.properties.matches.items.required).toEqual([
      "vendorLineIndex",
      "candidateIndex",
      "confidence",
      "reasoning",
    ]);
    expect(MATCH_SCHEMA.schema.properties.matches.items.additionalProperties).toBe(false);
  });
});
