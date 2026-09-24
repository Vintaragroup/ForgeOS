import { describe, expect, it } from "vitest";
import { describeEffect, effectOf, movesMoney, type ApplicableProposal } from "@/lib/recost-apply";

function proposal(over: Partial<ApplicableProposal> = {}): ApplicableProposal {
  return { action: "REMOVE", lineItemId: "li-1", sectionId: null, newUnitCost: null, newQty: null, ...over };
}

describe("effectOf", () => {
  it("removes the line item a removal names", () => {
    expect(effectOf(proposal())).toEqual({ kind: "DELETE_LINE_ITEM", lineItemId: "li-1" });
  });

  // How an estimator thinks about "the reception counter" -- one thing,
  // not 25 separate removals.
  it("removes a whole section's items when that is what was proposed", () => {
    expect(effectOf(proposal({ lineItemId: null, sectionId: "sec-1" }))).toEqual({
      kind: "DELETE_SECTION_ITEMS",
      sectionId: "sec-1",
    });
  });

  it("writes a price the source stated", () => {
    expect(effectOf(proposal({ action: "REPRICE", newUnitCost: 13000 }))).toEqual({
      kind: "SET_UNIT_COST",
      lineItemId: "li-1",
      unitCost: 13000,
    });
  });

  it("treats re-sourcing as a reprice once there is a number", () => {
    expect(effectOf(proposal({ action: "RE_SOURCE", newUnitCost: 2800 }))).toEqual({
      kind: "SET_UNIT_COST",
      lineItemId: "li-1",
      unitCost: 2800,
    });
  });

  it("writes a quantity a reduction stated", () => {
    expect(effectOf(proposal({ action: "REDUCE_QTY", newQty: 2 }))).toEqual({
      kind: "SET_QTY",
      lineItemId: "li-1",
      qty: 2,
    });
  });

  // The whole reason this module is separate from "accept". These are
  // real agreed findings with nothing to write, and that has to be said
  // rather than silently treated as done.
  describe("accepted, with nothing to apply", () => {
    it("says so for a change nobody has priced", () => {
      const effect = effectOf(proposal({ action: "NEEDS_QUOTE" }));
      expect(effect).toEqual({ kind: "NOTHING_TO_APPLY", why: "nobody has priced this yet — it needs a quote" });
    });

    it("says so for new scope", () => {
      const effect = effectOf(proposal({ action: "ADD", lineItemId: null, sectionId: "sec-1" }));
      expect(effect.kind).toBe("NOTHING_TO_APPLY");
    });

    // The validation stage strips a price that was not in the source, on
    // purpose. This is where that lands.
    it("says so for a reprice whose number was stripped", () => {
      const effect = effectOf(proposal({ action: "REPRICE", newUnitCost: null }));
      expect(effect.kind).toBe("NOTHING_TO_APPLY");
      expect(effect).toHaveProperty("why", expect.stringContaining("needs a number"));
    });

    it("says so for a reduction with no new quantity", () => {
      expect(effectOf(proposal({ action: "REDUCE_QTY", newQty: null })).kind).toBe("NOTHING_TO_APPLY");
    });

    it("says so for a removal that names nothing", () => {
      expect(effectOf(proposal({ lineItemId: null, sectionId: null })).kind).toBe("NOTHING_TO_APPLY");
    });
  });
});

describe("movesMoney", () => {
  it("separates the ones that change the total from the ones that do not", () => {
    expect(movesMoney(effectOf(proposal()))).toBe(true);
    expect(movesMoney(effectOf(proposal({ action: "NEEDS_QUOTE" })))).toBe(false);
  });
});

describe("describeEffect", () => {
  // Told before the click, not explained after it.
  it("counts the rows a section removal would take", () => {
    const text = describeEffect(effectOf(proposal({ lineItemId: null, sectionId: "sec-1" })), {
      itemCount: 25,
      amount: 7917,
    });
    expect(text).toContain("all 25 line items");
    expect(text).toContain("$7,917");
  });

  it("names the money a single removal takes out", () => {
    expect(describeEffect(effectOf(proposal()), { amount: 55943 })).toContain("$55,943");
  });

  it("names the new number a reprice writes", () => {
    expect(describeEffect(effectOf(proposal({ action: "REPRICE", newUnitCost: 13000 })), {})).toContain("$13,000");
  });

  it("explains rather than promises when there is nothing to apply", () => {
    const text = describeEffect(effectOf(proposal({ action: "NEEDS_QUOTE" })), {});
    expect(text).toMatch(/^Records the decision/);
    expect(text).toContain("needs a quote");
  });
});
