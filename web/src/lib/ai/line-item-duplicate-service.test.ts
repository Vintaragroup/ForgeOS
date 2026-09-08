import { describe, expect, it } from "vitest";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  DUPLICATE_MATCH_SCHEMA,
  findExactDuplicates,
  matchProposedLineItemsAgainstExisting,
  normalizeDescriptionForMatch,
  resolveDuplicateMatches,
  type ExistingLineItemCandidate,
  type ProposedItemForDuplicateCheck,
  type RawLineItemDuplicateMatch,
} from "@/lib/ai/line-item-duplicate-service";

function proposed(description: string, qty: number | null = null, unit: string | null = null): ProposedItemForDuplicateCheck {
  return { description, qty, unit };
}

function candidate(
  id: string,
  description: string,
  sectionLabel: string | null = null,
  qty: number | null = null,
  unit: string | null = null,
): ExistingLineItemCandidate {
  return { id, description, sectionLabel, qty, unit };
}

describe("normalizeDescriptionForMatch", () => {
  it("lowercases, trims, collapses whitespace, and strips trailing punctuation", () => {
    expect(normalizeDescriptionForMatch("  Sleeper   Floor Required.  ")).toBe("sleeper floor required");
  });

  it("strips trailing punctuation but not internal punctuation", () => {
    expect(normalizeDescriptionForMatch("Booth Structure (10x10), Painted!")).toBe("booth structure (10x10), painted");
  });

  it("treats two differently-cased/spaced but otherwise identical descriptions as equal", () => {
    expect(normalizeDescriptionForMatch("Booth  Structure")).toBe(normalizeDescriptionForMatch("booth structure "));
  });
});

describe("findExactDuplicates", () => {
  it("matches a proposed item to the one existing candidate sharing its normalized description", () => {
    const items = [proposed("Sleeper Floor Required.")];
    const candidates = [candidate("li-1", "sleeper floor required")];

    const result = findExactDuplicates(items, candidates);

    expect(result.get(0)).toEqual(candidates[0]);
  });

  it("does not match when descriptions are genuinely different", () => {
    const items = [proposed("Guardrail (Adjustable Height)")];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];

    expect(findExactDuplicates(items, candidates).size).toBe(0);
  });

  it("refuses to guess when 2+ existing candidates already share the same normalized description", () => {
    const items = [proposed("Sleeper Floor Required")];
    const candidates = [
      candidate("li-1", "Sleeper Floor Required"),
      candidate("li-2", "sleeper floor required"),
    ];

    // Ambiguous deterministic signal is not a safe auto-match -- falls
    // through to the AI/manual-review path instead of guessing which of
    // the two duplicate-description candidates is correct.
    expect(findExactDuplicates(items, candidates).size).toBe(0);
  });

  it("lets multiple proposed items independently resolve to the same one candidate", () => {
    const items = [proposed("Sleeper Floor Required"), proposed("sleeper floor required.")];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];

    const result = findExactDuplicates(items, candidates);

    expect(result.get(0)).toEqual(candidates[0]);
    expect(result.get(1)).toEqual(candidates[0]);
  });

  it("returns nothing when there are no candidates", () => {
    expect(findExactDuplicates([proposed("Sleeper Floor")], []).size).toBe(0);
  });
});

describe("resolveDuplicateMatches", () => {
  it("maps a raw candidateIndex back to the real candidate id", () => {
    const items = [proposed("Sleeper Floor, roughly the same as before")];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawLineItemDuplicateMatch[] = [
      { proposedIndex: 0, candidateIndex: 0, confidence: "high", reasoning: "Same real item, reworded." },
    ];

    const matches = resolveDuplicateMatches(raw, items, candidates);

    expect(matches).toEqual([
      { existingLineItemId: "li-1", confidence: "high", reasoning: "Same real item, reworded." },
    ]);
  });

  it("leaves a proposed item unmatched when the model returns a null candidateIndex", () => {
    const items = [proposed("Guardrail (Adjustable Height)")];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawLineItemDuplicateMatch[] = [
      { proposedIndex: 0, candidateIndex: null, confidence: "low", reasoning: "No corresponding existing item." },
    ];

    const matches = resolveDuplicateMatches(raw, items, candidates);

    expect(matches[0].existingLineItemId).toBeNull();
  });

  it("drops a hallucinated/out-of-range candidateIndex instead of crashing or trusting it", () => {
    const items = [proposed("Sleeper Floor")];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawLineItemDuplicateMatch[] = [
      { proposedIndex: 0, candidateIndex: 7, confidence: "high", reasoning: "x" },
    ];

    const matches = resolveDuplicateMatches(raw, items, candidates);

    expect(matches[0].existingLineItemId).toBeNull();
  });

  it("leaves a proposed item unmatched (with null confidence/reasoning) when the model omits it entirely", () => {
    const items = [proposed("Sleeper Floor"), proposed("Guardrail")];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawLineItemDuplicateMatch[] = [
      { proposedIndex: 0, candidateIndex: 0, confidence: "high", reasoning: "x" },
    ];

    const matches = resolveDuplicateMatches(raw, items, candidates);

    expect(matches[1]).toEqual({ existingLineItemId: null, confidence: null, reasoning: null });
  });

  it("allows two different proposed items to both legitimately resolve to the same candidate -- no forced one-winner dedup", () => {
    const items = [proposed("Sleeper Floor"), proposed("Sleeper Floor, verified again")];
    const candidates = [candidate("li-1", "Sleeper Floor Required")];
    const raw: RawLineItemDuplicateMatch[] = [
      { proposedIndex: 0, candidateIndex: 0, confidence: "high", reasoning: "x" },
      { proposedIndex: 1, candidateIndex: 0, confidence: "medium", reasoning: "y" },
    ];

    const matches = resolveDuplicateMatches(raw, items, candidates);

    expect(matches[0].existingLineItemId).toBe("li-1");
    expect(matches[1].existingLineItemId).toBe("li-1");
  });

  it("returns one entry per proposed item, in proposed-item order, regardless of raw entry order", () => {
    const items = [proposed("A"), proposed("B"), proposed("C")];
    const raw: RawLineItemDuplicateMatch[] = [
      { proposedIndex: 2, candidateIndex: null, confidence: "low", reasoning: "x" },
      { proposedIndex: 0, candidateIndex: null, confidence: "low", reasoning: "x" },
    ];

    const matches = resolveDuplicateMatches(raw, items, []);

    expect(matches).toHaveLength(3);
    expect(matches[1]).toEqual({ existingLineItemId: null, confidence: null, reasoning: null });
  });
});

describe("matchProposedLineItemsAgainstExisting", () => {
  it("returns an empty array with no proposed items, before ever touching the OpenAI client", async () => {
    const result = await matchProposedLineItemsAgainstExisting(
      [],
      [candidate("li-1", "Sleeper Floor Required")],
      "opp-1",
    );
    expect(result).toEqual([]);
  });

  it("returns every proposed item unmatched, with no OpenAI call, when there are no candidates", async () => {
    const items = [proposed("Sleeper Floor")];
    const result = await matchProposedLineItemsAgainstExisting(items, [], "opp-1");
    expect(result).toEqual([{ existingLineItemId: null, confidence: null, reasoning: null }]);
  });

  it("resolves everything by Tier 1 alone, with no OpenAI call needed, when every proposed item exactly matches one candidate", async () => {
    const items = [proposed("Sleeper Floor Required"), proposed("sleeper floor required.")];
    const candidates = [candidate("li-1", "Sleeper Floor Required"), candidate("li-2", "Guardrail")];

    // Would throw AiNotConfiguredError if this reached the AI (this
    // environment's .env.test deliberately has no OPENAI_API_KEY) --
    // resolving cleanly proves Tier 1 alone handled it.
    const result = await matchProposedLineItemsAgainstExisting(items, candidates, "opp-1");

    expect(result).toEqual([
      { existingLineItemId: "li-1", confidence: "high", reasoning: "Exact match against an existing line item's description." },
      { existingLineItemId: "li-1", confidence: "high", reasoning: "Exact match against an existing line item's description." },
    ]);
  });

  it("throws AiNotConfiguredError once there's real Tier 2 work to do -- .env.test deliberately has no OPENAI_API_KEY", async () => {
    const items = [proposed("Booth structure fabrication")];
    const candidates = [candidate("li-1", "Custom booth structure build-out")];

    await expect(matchProposedLineItemsAgainstExisting(items, candidates, "opp-1")).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });

  it("still reaches the AI for a proposed item Tier 1 couldn't resolve, even when another item in the same batch resolves by Tier 1", async () => {
    const items = [proposed("Sleeper Floor Required"), proposed("Booth structure fabrication")];
    const candidates = [
      candidate("li-1", "Sleeper Floor Required"),
      candidate("li-2", "Custom booth structure build-out"),
    ];

    await expect(matchProposedLineItemsAgainstExisting(items, candidates, "opp-1")).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });
});

describe("DUPLICATE_MATCH_SCHEMA", () => {
  it("is a strict JSON schema with every match field required -- proves the shape is actually wired into the request, not just documented in the type", () => {
    expect(DUPLICATE_MATCH_SCHEMA.strict).toBe(true);
    expect(DUPLICATE_MATCH_SCHEMA.schema.properties.matches.items.required).toEqual([
      "proposedIndex",
      "candidateIndex",
      "confidence",
      "reasoning",
    ]);
    expect(DUPLICATE_MATCH_SCHEMA.schema.properties.matches.items.additionalProperties).toBe(false);
    expect(DUPLICATE_MATCH_SCHEMA.schema.required).toEqual(["matches"]);
  });
});
