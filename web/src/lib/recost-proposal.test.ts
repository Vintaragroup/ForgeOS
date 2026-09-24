import { describe, expect, it } from "vitest";
import { validateProposals, type ProposalContext, type RawProposal } from "@/lib/recost-proposal";

// Full Swing's real drawing finding, verbatim.
const FRONT_STRUCTURE =
  "The front structure with monitors and LED elements is no longer present.";
const SIGN =
  "The hanging sign now displays additional text reading 'FEEDBACK PERFORMANCE' and 'PRACTICE PURPOSE' in blue " +
  "lettering on the black sections, which was not present in the previous design.";
const FUSE = "Fuse is no longer supplying AV on this job. The five 100\" monitors will be purchased at 2800.00 each.";

function context(over: Partial<ProposalContext> = {}): ProposalContext {
  return {
    mode: "VALUE_ENGINEERING",
    findings: [
      { id: "F1", sourceDocumentId: "doc-drawing", sourceText: FRONT_STRUCTURE },
      { id: "F2", sourceDocumentId: "doc-drawing", sourceText: SIGN },
      { id: "F3", sourceDocumentId: "doc-fuse", sourceText: FUSE },
    ],
    lineItemIds: new Set(["li-1", "li-2"]),
    sectionIds: new Set(["sec-1"]),
    ...over,
  };
}

function proposal(over: Partial<RawProposal> = {}): RawProposal {
  return {
    findingId: "F1",
    action: "REMOVE",
    lineItemIds: ["li-1"],
    reason: "The structure these line items price is gone from the revised drawing.",
    sourceQuote: FRONT_STRUCTURE,
    confidence: "NEED_YOUR_DECISION",
    ...over,
  };
}

describe("validateProposals", () => {
  it("keeps a proposal that names real rows and cites its source", () => {
    const { proposals, rejected } = validateProposals([proposal()], context());
    expect(rejected).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].lineItemIds).toEqual(["li-1"]);
    // Carried from the finding, never from the model: a model that can
    // nominate its own source can cite anything.
    expect(proposals[0].sourceDocumentId).toBe("doc-drawing");
  });

  // The check this module exists for. A quote that is not in the
  // document is worse than no quote, because it reads as evidence.
  it("drops a proposal whose quote is not in the source it cites", () => {
    const { proposals, rejected } = validateProposals(
      [proposal({ sourceQuote: "The front structure was removed at the client's request to save $40,000." })],
      context(),
    );
    expect(proposals).toEqual([]);
    expect(rejected[0].why).toMatch(/quote does not appear/);
  });

  it("accepts a quote the model reformatted but did not rewrite", () => {
    const { proposals } = validateProposals(
      [proposal({ sourceQuote: "  The Front Structure with monitors and LED elements   is no longer present. " })],
      context(),
    );
    expect(proposals).toHaveLength(1);
  });

  it("refuses a quote too short to mean anything", () => {
    const { rejected } = validateProposals([proposal({ sourceQuote: "LED" })], context());
    expect(rejected[0].why).toMatch(/quote does not appear/);
  });

  it("drops ids this estimate does not have", () => {
    const { proposals, rejected } = validateProposals(
      [proposal({ lineItemIds: ["li-1", "li-999"] })],
      context(),
    );
    expect(proposals[0].lineItemIds).toEqual(["li-1"]);
    expect(rejected).toEqual([]);
  });

  it("drops a proposal that names nothing real at all", () => {
    const { proposals, rejected } = validateProposals(
      [proposal({ lineItemIds: ["li-999"], sectionId: "sec-999" })],
      context(),
    );
    expect(proposals).toEqual([]);
    expect(rejected[0].why).toMatch(/does not name a line item or section/);
  });

  it("drops a proposal about a finding nobody raised", () => {
    const { rejected } = validateProposals([proposal({ findingId: "F99" })], context());
    expect(rejected[0].why).toMatch(/not in the review/);
  });

  it("drops an action this system cannot take", () => {
    const { rejected } = validateProposals([proposal({ action: "DELETE_BOOTH" })], context());
    expect(rejected[0].why).toMatch(/not one this system can take/);
  });

  it("drops a proposal with no reason", () => {
    const { rejected } = validateProposals([proposal({ reason: "  " })], context());
    expect(rejected[0].why).toMatch(/no reason/);
  });

  // A whole booth is how an estimator thinks about "the reception
  // counter", rather than as 25 separate removals.
  it("allows a section target when no line item is named", () => {
    const { proposals } = validateProposals(
      [proposal({ lineItemIds: [], sectionId: "sec-1" })],
      context(),
    );
    expect(proposals[0].sectionId).toBe("sec-1");
    expect(proposals[0].lineItemIds).toEqual([]);
  });

  it("prefers line items when the model gave both", () => {
    const { proposals } = validateProposals(
      [proposal({ lineItemIds: ["li-1"], sectionId: "sec-1" })],
      context(),
    );
    expect(proposals[0].lineItemIds).toEqual(["li-1"]);
    expect(proposals[0].sectionId).toBeNull();
  });

  // On a value-engineering job the client likes the design. Of roughly
  // forty elements on Full Swing, exactly two were true eliminations.
  it("never pre-confirms a removal while value engineering", () => {
    const { proposals } = validateProposals(
      [proposal({ action: "REMOVE", confidence: "RECOMMEND_AND_CONFIRM" })],
      context(),
    );
    expect(proposals[0].confidence).toBe("NEED_YOUR_DECISION");
  });

  it("lets a removal be recommended on a redesign", () => {
    const { proposals } = validateProposals(
      [proposal({ action: "REMOVE", confidence: "RECOMMEND_AND_CONFIRM" })],
      context({ mode: "REDESIGN" }),
    );
    expect(proposals[0].confidence).toBe("RECOMMEND_AND_CONFIRM");
  });

  it("defaults to needing a decision when confidence is missing or unreadable", () => {
    const { proposals } = validateProposals(
      [proposal({ action: "REPRICE", confidence: undefined }), proposal({ action: "REPRICE", confidence: "sure" })],
      context(),
    );
    expect(proposals.every((p) => p.confidence === "NEED_YOUR_DECISION")).toBe(true);
  });

  describe("money the model proposes", () => {
    // The user's own case: Fuse is off the job and the five monitors
    // are being purchased at $2,800 each. That number IS in the source.
    it("keeps a price the source actually states", () => {
      const { proposals } = validateProposals(
        [proposal({ findingId: "F3", action: "RE_SOURCE", sourceQuote: FUSE, newUnitCost: 2800, newQty: 5 })],
        context(),
      );
      expect(proposals[0].newUnitCost).toBe(2800);
      // 5 is in "five 100\" monitors" only as a word, and 5 never
      // appears as a numeral -- so it does not survive, which is the
      // rule working rather than failing.
      expect(proposals[0].newQty).toBeNull();
    });

    // The rule the estimating guidelines are explicit about: do not
    // infer what the document does not state.
    it("strips a price nobody wrote down, and keeps the question", () => {
      const { proposals } = validateProposals(
        [proposal({ findingId: "F2", action: "REPRICE", sourceQuote: SIGN, newUnitCost: 13000 })],
        context(),
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0].newUnitCost).toBeNull();
    });

    it("ignores money on an action that cannot carry it", () => {
      const { proposals } = validateProposals(
        [proposal({ findingId: "F3", action: "REMOVE", sourceQuote: FUSE, newUnitCost: 2800 })],
        context(),
      );
      expect(proposals[0].newUnitCost).toBeNull();
    });

    it("matches a price whatever way it was written", () => {
      const quote = 'The revised sign is quoted at $13,000.00 all in.';
      const { proposals } = validateProposals(
        [proposal({ findingId: "F4", action: "REPRICE", sourceQuote: quote, newUnitCost: 13000 })],
        context({
          findings: [{ id: "F4", sourceDocumentId: "doc-quote", sourceText: quote }],
        }),
      );
      expect(proposals[0].newUnitCost).toBe(13000);
    });
  });

  // "No proposal" is a legitimate answer. It is still the number a
  // prompt change should be measured against, so it is reported rather
  // than shrugged off.
  it("reports findings nothing was proposed for", () => {
    const { uncovered } = validateProposals([proposal({ findingId: "F1" })], context());
    expect(uncovered).toEqual(["F2", "F3"]);
  });

  it("returns nothing for nothing", () => {
    const out = validateProposals([], context());
    expect(out.proposals).toEqual([]);
    expect(out.uncovered).toEqual(["F1", "F2", "F3"]);
  });
});
