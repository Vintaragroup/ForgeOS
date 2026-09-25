import { describe, expect, it } from "vitest";
import { dropZeroGroups, type ElementGroup } from "@/lib/proposal-view-model";

function item(description: string, totalCost: number, isClientOwned = false) {
  return {
    key: description,
    description,
    qty: 1,
    unit: null,
    totalCost,
    isClientOwned,
    elementLabel: null,
  } as ElementGroup["tradeGroups"][number]["items"][number];
}

function group(tradeCategory: string, subtotal: number, items = [item(tradeCategory, subtotal)]) {
  return {
    tradeCategory,
    items,
    subgroups: [],
    subtotal,
    elementSummary: null,
    summarizeOnProposal: false,
  } as ElementGroup["tradeGroups"][number];
}

function element(elementLabel: string, tradeGroups: ElementGroup["tradeGroups"]): ElementGroup {
  return {
    elementLabel,
    boothDescription: null,
    tradeGroups,
    subtotal: tradeGroups.reduce((n, g) => n + g.subtotal, 0),
    summarizeOnProposal: false,
    boothSummary: null,
  };
}

describe("dropZeroGroups", () => {
  // The reported case: SS - Lit Spines Hit Bay printed "STRUCTURE $0.00"
  // between two real trade groups on a proposal about to go to a client.
  it("drops a $0 trade group and keeps its siblings", () => {
    const out = dropZeroGroups([
      element("SS - Lit Spines Hit Bay", [
        group("Custom Build", 32836.33),
        group("Structure", 0),
        group("Graphics", 1467),
      ]),
    ]);
    expect(out[0].tradeGroups.map((g) => g.tradeCategory)).toEqual(["Custom Build", "Graphics"]);
  });

  it("drops an element once everything inside it has gone", () => {
    const out = dropZeroGroups([
      element("Real Booth", [group("Custom Build", 100)]),
      element("Empty Booth", [group("Structure", 0), group("Other", 0)]),
    ]);
    expect(out.map((b) => b.elementLabel)).toEqual(["Real Booth"]);
  });

  it("drops an element that never had a line item in it", () => {
    expect(dropZeroGroups([element("Doors & Hardware", [])])).toEqual([]);
  });

  // The guarantee that makes this safe to apply with no review: everything
  // removed sums to zero, so no total anywhere can move.
  it("cannot change what the document adds up to", () => {
    const groups = [
      element("A", [group("Custom Build", 32836.33), group("Structure", 0)]),
      element("B", [group("Other", 0)]),
      element("C", [group("Graphics", 1467)]),
    ];
    const total = (bs: ElementGroup[]) => bs.reduce((n, b) => n + b.subtotal, 0);
    expect(total(dropZeroGroups(groups))).toBeCloseTo(total(groups), 2);
  });

  // A client-owned row prints "Client Owned", not $0.00 -- it is scope the
  // client supplies, deliberately shown at no charge.
  it("keeps a $0 group whose items are all client-owned", () => {
    const out = dropZeroGroups([
      element("FS - Hitting Bay Wall", [
        group("Client Supplied", 0, [item("Client's own turf", 0, true)]),
        group("Structure", 0, [item("PURCHASE — connectors", 0)]),
      ]),
    ]);
    expect(out[0].tradeGroups.map((g) => g.tradeCategory)).toEqual(["Client Supplied"]);
  });

  it("keeps an element alive when its only surviving trade is client-owned", () => {
    const out = dropZeroGroups([
      element("Client Booth", [group("Client Supplied", 0, [item("Client's own monitors", 0, true)])]),
    ]);
    expect(out).toHaveLength(1);
  });

  it("leaves a document with nothing at $0 exactly as it was", () => {
    const groups = [element("A", [group("Custom Build", 100)])];
    expect(dropZeroGroups(groups)).toEqual(groups);
  });
});
