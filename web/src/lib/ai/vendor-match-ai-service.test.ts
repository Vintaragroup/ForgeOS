import { describe, expect, it } from "vitest";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  findClosestCandidateId,
  findPositionCodeMatches,
  MATCH_SCHEMA,
  matchVendorQuoteLinesWithAi,
  resolveProposedVendorSections,
  resolveVendorLineMatches,
  type MatchCandidate,
  type RawProposedVendorSection,
  type RawVendorLineMatch,
  type VendorLineMatch,
  type VendorQuoteLine,
} from "@/lib/ai/vendor-match-ai-service";

function vendorLine(description: string, unitPrice: number, unitCode: string | null = null): VendorQuoteLine {
  return {
    description,
    unit: null,
    qty: null,
    unitPrice,
    totalPrice: null,
    sourceQuote: description,
    unitCode,
    pageNumber: null,
  };
}

function rawMatch(
  overrides: Partial<RawVendorLineMatch> & Pick<RawVendorLineMatch, "vendorLineIndex" | "candidateIndex" | "confidence" | "reasoning">,
): RawVendorLineMatch {
  return { needsClarification: false, ...overrides };
}

function candidate(
  id: string,
  description: string,
  sectionLabel: string | null = null,
  positionCode: string | null = null,
): MatchCandidate {
  return { id, description, sectionLabel, qty: null, unit: null, positionCode };
}

describe("matchVendorQuoteLinesWithAi", () => {
  it("returns no matches and no proposed sections with no vendor lines, before ever touching the OpenAI client", async () => {
    const result = await matchVendorQuoteLinesWithAi([], [candidate("li-1", "Sleeper Floor Required")], "opp-1");
    expect(result).toEqual({ matches: [], proposedSections: [] });
  });

  it("returns every vendor line unmatched, with no OpenAI call, when there are no candidates", async () => {
    const lines = [vendorLine("Sleeper Floor", 840)];
    const result = await matchVendorQuoteLinesWithAi(lines, [], "opp-1");
    expect(result).toEqual({
      matches: [
        {
          vendorLine: lines[0],
          lineItemId: null,
          confidence: null,
          reasoning: null,
          needsClarification: false,
          suggestedLineItemId: null,
        },
      ],
      proposedSections: [],
    });
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

  // Real fixture pair: ShowRig's own quote uses "CAM-01" the same way
  // Arena's revised RFP response's own "Ref." column does (see
  // pricing-import-service.ts's Ref.-column capture) -- once both sides
  // carry that code, matching it needs no AI judgment call at all.
  it("resolves every vendor line by shared position code, with no OpenAI call needed, when every line has one", async () => {
    const lines = [
      vendorLine("Non Slip Paint", 450, "CAM-01"),
      vendorLine("Guardrail (Adjustable Height)", 425, "CAM-01"),
    ];
    const candidates = [candidate("li-1", "Right Endzone Camera Platform — Near", "Section 1", "CAM-01")];

    // Would throw AiNotConfiguredError if this reached the AI (same
    // env.test guarantee the test above relies on) -- resolving cleanly
    // proves the position-code path is what actually handled this.
    const result = await matchVendorQuoteLinesWithAi(lines, candidates, "opp-1");

    expect(result.matches).toEqual([
      {
        vendorLine: lines[0],
        lineItemId: "li-1",
        confidence: "high",
        reasoning: 'Matched by shared position code "CAM-01".',
        needsClarification: false,
        suggestedLineItemId: "li-1",
      },
      {
        vendorLine: lines[1],
        lineItemId: "li-1",
        confidence: "high",
        reasoning: 'Matched by shared position code "CAM-01".',
        needsClarification: false,
        suggestedLineItemId: "li-1",
      },
    ]);
    expect(result.proposedSections).toEqual([]);
  });

  it("still reaches the AI (throws AiNotConfiguredError) for a vendor line whose code doesn't match any candidate, even when another line resolves by code", async () => {
    const lines = [vendorLine("Non Slip Paint", 450, "CAM-01"), vendorLine("Miscellaneous", 200, "CAM-99")];
    const candidates = [
      candidate("li-1", "Right Endzone Camera Platform — Near", "Section 1", "CAM-01"),
      // Left unclaimed by any position code -- still a real candidate the
      // second vendor line COULD plausibly match, so the AI genuinely has
      // work to do here (unlike the "0 candidates left" case above).
      candidate("li-2", "Soft Goods", "Section 1"),
    ];

    // CAM-01 resolves deterministically; CAM-99 has no matching candidate
    // position code, so this must still fall through to the AI for that
    // one line -- proven by the AiNotConfiguredError this environment
    // guarantees for any real AI call.
    await expect(matchVendorQuoteLinesWithAi(lines, candidates, "opp-1")).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe("findPositionCodeMatches", () => {
  it("matches a vendor line's unitCode to a candidate's positionCode, case/whitespace-insensitively", () => {
    const lines = [vendorLine("Non Slip Paint", 450, " cam-01 ")];
    const candidates = [candidate("li-1", "Right Endzone Camera Platform", null, "CAM-01")];

    const result = findPositionCodeMatches(lines, candidates);

    expect(result.get(0)).toEqual(candidates[0]);
  });

  it("does not match when the vendor line has no unitCode", () => {
    const lines = [vendorLine("Non Slip Paint", 450, null)];
    const candidates = [candidate("li-1", "Right Endzone Camera Platform", null, "CAM-01")];

    expect(findPositionCodeMatches(lines, candidates).size).toBe(0);
  });

  it("does not match when no candidate carries a positionCode at all", () => {
    const lines = [vendorLine("Non Slip Paint", 450, "CAM-01")];
    const candidates = [candidate("li-1", "Right Endzone Camera Platform")];

    expect(findPositionCodeMatches(lines, candidates).size).toBe(0);
  });

  it("refuses to guess when the same position code is (incorrectly) reused across multiple candidates", () => {
    const lines = [vendorLine("Non Slip Paint", 450, "CAM-01")];
    const candidates = [
      candidate("li-1", "Right Endzone Camera Platform — Near", null, "CAM-01"),
      candidate("li-2", "Right Endzone Camera Platform — Far", null, "CAM-01"),
    ];

    // An ambiguous deterministic signal is not a safe auto-match --
    // falls through to the AI/manual-review path instead of guessing
    // which of the two duplicate-coded candidates is correct.
    expect(findPositionCodeMatches(lines, candidates).size).toBe(0);
  });

  it("lets multiple vendor lines under the same code all resolve to the one candidate that code identifies", () => {
    const lines = [vendorLine("Non Slip Paint", 450, "CAM-01"), vendorLine("Guardrail", 425, "CAM-01")];
    const candidates = [candidate("li-1", "Right Endzone Camera Platform", null, "CAM-01")];

    const result = findPositionCodeMatches(lines, candidates);

    expect(result.get(0)).toEqual(candidates[0]);
    expect(result.get(1)).toEqual(candidates[0]);
  });
});

describe("resolveVendorLineMatches", () => {
  // Real fixture pair from the ShowRig quote this feature was built for.
  it("maps a raw candidateIndex back to the real candidate id", () => {
    const lines = [vendorLine("Sleeper Floor", 840, "CAM-06")];
    const candidates = [candidate("li-1", "Sleeper Floor Required", "Section 203")];
    const raw: RawVendorLineMatch[] = [
      rawMatch({ vendorLineIndex: 0, candidateIndex: 0, confidence: "high", reasoning: "Same item, matching price." }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches).toEqual([
      {
        vendorLine: lines[0],
        lineItemId: "li-1",
        confidence: "high",
        reasoning: "Same item, matching price.",
        needsClarification: false,
        suggestedLineItemId: "li-1",
      },
    ]);
  });

  it("leaves a vendor line unmatched when the model returns a null candidateIndex", () => {
    const lines = [vendorLine("Guardrail (Adjustable Height)", 425)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [
      rawMatch({ vendorLineIndex: 0, candidateIndex: null, confidence: "low", reasoning: "No corresponding scope item." }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[0].lineItemId).toBeNull();
  });

  it("drops a hallucinated/out-of-range candidateIndex instead of crashing or trusting it", () => {
    const lines = [vendorLine("Sleeper Floor", 840)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [
      rawMatch({ vendorLineIndex: 0, candidateIndex: 7, confidence: "high", reasoning: "x" }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[0].lineItemId).toBeNull();
  });

  it("leaves a vendor line unmatched (with null confidence/reasoning) when the model omits it entirely", () => {
    const lines = [vendorLine("Sleeper Floor", 840), vendorLine("Guardrail", 425)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    // Model only addressed vendor line 0, skipping line 1 -- a truncated
    // or incomplete response shouldn't crash the mapping.
    const raw: RawVendorLineMatch[] = [
      rawMatch({ vendorLineIndex: 0, candidateIndex: 0, confidence: "high", reasoning: "x" }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[1]).toEqual({
      vendorLine: lines[1],
      lineItemId: null,
      confidence: null,
      reasoning: null,
      needsClarification: false,
      suggestedLineItemId: null,
    });
  });

  it("keeps only the highest-confidence claim when the model assigns the same candidate twice", () => {
    const lines = [vendorLine("Sleeper Floor", 840), vendorLine("Sleeper Floor Required for platform", 900)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [
      rawMatch({ vendorLineIndex: 0, candidateIndex: 0, confidence: "medium", reasoning: "Plausible match." }),
      rawMatch({ vendorLineIndex: 1, candidateIndex: 0, confidence: "high", reasoning: "Stronger description overlap." }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[1].lineItemId).toBe("li-1");
    expect(matches[0].lineItemId).toBeNull();
    expect(matches[0].confidence).toBe("low");
  });

  it("retains suggestedLineItemId on a dedup loser even though lineItemId is nulled out", () => {
    const lines = [vendorLine("Sleeper Floor", 840), vendorLine("Sleeper Floor Required for platform", 900)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [
      rawMatch({ vendorLineIndex: 0, candidateIndex: 0, confidence: "medium", reasoning: "Plausible match." }),
      rawMatch({ vendorLineIndex: 1, candidateIndex: 0, confidence: "high", reasoning: "Stronger description overlap." }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    // Loser (index 0): lineItemId nulled by dedup, but the pre-dedup
    // suggestion survives so the UI can still pre-fill/group with it.
    expect(matches[0].lineItemId).toBeNull();
    expect(matches[0].suggestedLineItemId).toBe("li-1");
    // Winner (index 1): both fields point at the same real match.
    expect(matches[1].lineItemId).toBe("li-1");
    expect(matches[1].suggestedLineItemId).toBe("li-1");
  });

  it("returns one entry per vendor line, in vendor-line order, regardless of raw entry order", () => {
    const lines = [vendorLine("A", 1), vendorLine("B", 2), vendorLine("C", 3)];
    const raw: RawVendorLineMatch[] = [
      rawMatch({ vendorLineIndex: 2, candidateIndex: null, confidence: "low", reasoning: "x" }),
      rawMatch({ vendorLineIndex: 0, candidateIndex: null, confidence: "low", reasoning: "x" }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, []);

    expect(matches.map((m) => m.vendorLine.description)).toEqual(["A", "B", "C"]);
  });

  it("carries needsClarification through from the raw match for a vague vendor line", () => {
    const lines = [vendorLine("Test and adjust", 189000)];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawVendorLineMatch[] = [
      rawMatch({
        vendorLineIndex: 0,
        candidateIndex: null,
        confidence: "low",
        reasoning: "No object stated -- unclear what is being tested or adjusted.",
        needsClarification: true,
      }),
    ];

    const matches = resolveVendorLineMatches(raw, lines, candidates);

    expect(matches[0].needsClarification).toBe(true);
    expect(matches[0].lineItemId).toBeNull();
  });
});

function fakeMatches(lineItemIds: (string | null)[]): VendorLineMatch[] {
  return lineItemIds.map((lineItemId, i) => ({
    vendorLine: vendorLine(`Line ${i}`, 100),
    lineItemId,
    confidence: lineItemId ? "high" : null,
    reasoning: null,
    needsClarification: false,
    suggestedLineItemId: lineItemId,
  }));
}

describe("resolveProposedVendorSections", () => {
  it("resolves vendorLineIndices for a real category grouping several vendor lines", () => {
    const raw: RawProposedVendorSection[] = [
      {
        name: "One Time Service Costs",
        lineType: "FEE",
        reasoning: "Real cost category with no corresponding estimate section.",
        vendorLineIndices: [0, 2],
      },
    ];

    const proposals = resolveProposedVendorSections(raw, fakeMatches([null, null, null]), new Set());

    expect(proposals).toEqual([
      {
        name: "One Time Service Costs",
        lineType: "FEE",
        reasoning: "Real cost category with no corresponding estimate section.",
        vendorLineIndices: [0, 2],
      },
    ]);
  });

  it("drops a hallucinated/out-of-range vendorLineIndex instead of trusting it", () => {
    const raw: RawProposedVendorSection[] = [
      { name: "One Time Service Costs", lineType: "FEE", reasoning: "x", vendorLineIndices: [0, 99] },
    ];

    const proposals = resolveProposedVendorSections(raw, fakeMatches([null]), new Set());

    expect(proposals[0].vendorLineIndices).toEqual([0]);
  });

  it("drops a proposal entirely when none of its indices are valid", () => {
    const raw: RawProposedVendorSection[] = [
      { name: "Ghost Section", lineType: "FEE", reasoning: "x", vendorLineIndices: [5, 6] },
    ];

    const proposals = resolveProposedVendorSections(raw, fakeMatches([null, null, null]), new Set());

    expect(proposals).toEqual([]);
  });

  it("drops a vendorLineIndex whose match already resolved to a real lineItemId -- a live incident where a re-extract re-proposed a section for vendor lines that were already matched", () => {
    const raw: RawProposedVendorSection[] = [
      { name: "One Time Service Costs", lineType: "FEE", reasoning: "x", vendorLineIndices: [0, 1] },
    ];

    const proposals = resolveProposedVendorSections(raw, fakeMatches(["li-1", null]), new Set());

    expect(proposals[0].vendorLineIndices).toEqual([1]);
  });

  it("drops the whole proposal when its name collides (case/whitespace insensitive) with an existing section", () => {
    const raw: RawProposedVendorSection[] = [
      { name: "  one time service costs ", lineType: "FEE", reasoning: "x", vendorLineIndices: [0] },
    ];

    const proposals = resolveProposedVendorSections(
      raw,
      fakeMatches([null]),
      new Set(["One Time Service Costs"]),
    );

    expect(proposals).toEqual([]);
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
      "needsClarification",
    ]);
    expect(MATCH_SCHEMA.schema.properties.matches.items.additionalProperties).toBe(false);
    expect(MATCH_SCHEMA.schema.properties.proposedSections.items.required).toEqual([
      "name",
      "lineType",
      "reasoning",
      "vendorLineIndices",
    ]);
    expect(MATCH_SCHEMA.schema.properties.proposedSections.items.additionalProperties).toBe(false);
    expect(MATCH_SCHEMA.schema.required).toEqual(["matches", "proposedSections"]);
  });
});

describe("findClosestCandidateId", () => {
  // Same real fixture pair the deleted pre-AI vendor-match-service.ts
  // was tuned against: CAM-06's "Sleeper Floor" line vs. the existing
  // "Sleeper Floor Required" scope line item -- ported here as the
  // fallback default for when the AI found no candidate at all.
  it("finds a real vendor line's corresponding candidate by shared vocabulary", () => {
    const id = findClosestCandidateId("Sleeper Floor", [
      { id: "li-1", description: "Sleeper Floor Required" },
    ]);
    expect(id).toBe("li-1");
  });

  it("returns null for a genuinely unrelated vendor line -- sharing zero real vocabulary must stay unmatched, not guessed at", () => {
    const id = findClosestCandidateId("Guardrail (Adjustable Height)", [
      { id: "li-1", description: "Sleeper Floor Required" },
    ]);
    expect(id).toBeNull();
  });

  it("picks the candidate with the highest overlap when more than one is plausible", () => {
    const id = findClosestCandidateId("Sleeper Floor Required for platform", [
      { id: "li-1", description: "Sleeper Floor Required" },
      { id: "li-2", description: "Guardrail (Adjustable Height)" },
    ]);
    expect(id).toBe("li-1");
  });

  it("returns null when there are no candidates", () => {
    expect(findClosestCandidateId("Sleeper Floor", [])).toBeNull();
  });
});
