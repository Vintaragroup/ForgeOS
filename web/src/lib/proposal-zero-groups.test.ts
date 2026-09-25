import { describe, expect, it } from "vitest";
import { dropZeroGroups, type BoothGroup } from "@/lib/proposal-view-model";

function item(description: string, totalCost: number, isClientOwned = false) {
  return {
    key: description,
    description,
    qty: 1,
    unit: null,
    totalCost,
    isClientOwned,
    boothLabel: null,
  } as BoothGroup["elementGroups"][number]["items"][number];
}

function group(elementType: string, subtotal: number, items = [item(elementType, subtotal)]) {
  return {
    elementType,
    items,
    subgroups: [],
    subtotal,
    elementSummary: null,
    summarizeOnProposal: false,
  } as BoothGroup["elementGroups"][number];
}

function booth(boothLabel: string, elementGroups: BoothGroup["elementGroups"]): BoothGroup {
  return {
    boothLabel,
    boothDescription: null,
    elementGroups,
    subtotal: elementGroups.reduce((n, g) => n + g.subtotal, 0),
    summarizeOnProposal: false,
    boothSummary: null,
  };
}

describe("dropZeroGroups", () => {
  // The reported case: SS - Lit Spines Hit Bay printed "STRUCTURE $0.00"
  // between two real element groups on a proposal about to go to a client.
  it("drops a $0 element group and keeps its siblings", () => {
    const out = dropZeroGroups([
      booth("SS - Lit Spines Hit Bay", [
        group("Custom Build", 32836.33),
        group("Structure", 0),
        group("Graphics", 1467),
      ]),
    ]);
    expect(out[0].elementGroups.map((g) => g.elementType)).toEqual(["Custom Build", "Graphics"]);
  });

  it("drops a booth once everything inside it has gone", () => {
    const out = dropZeroGroups([
      booth("Real Booth", [group("Custom Build", 100)]),
      booth("Empty Booth", [group("Structure", 0), group("Other", 0)]),
    ]);
    expect(out.map((b) => b.boothLabel)).toEqual(["Real Booth"]);
  });

  it("drops a booth that never had a line item in it", () => {
    expect(dropZeroGroups([booth("Doors & Hardware", [])])).toEqual([]);
  });

  // The guarantee that makes this safe to apply with no review: everything
  // removed sums to zero, so no total anywhere can move.
  it("cannot change what the document adds up to", () => {
    const groups = [
      booth("A", [group("Custom Build", 32836.33), group("Structure", 0)]),
      booth("B", [group("Other", 0)]),
      booth("C", [group("Graphics", 1467)]),
    ];
    const total = (bs: BoothGroup[]) => bs.reduce((n, b) => n + b.subtotal, 0);
    expect(total(dropZeroGroups(groups))).toBeCloseTo(total(groups), 2);
  });

  // A client-owned row prints "Client Owned", not $0.00 -- it is scope the
  // client supplies, deliberately shown at no charge.
  it("keeps a $0 group whose items are all client-owned", () => {
    const out = dropZeroGroups([
      booth("FS - Hitting Bay Wall", [
        group("Client Supplied", 0, [item("Client's own turf", 0, true)]),
        group("Structure", 0, [item("PURCHASE — connectors", 0)]),
      ]),
    ]);
    expect(out[0].elementGroups.map((g) => g.elementType)).toEqual(["Client Supplied"]);
  });

  it("keeps a booth alive when its only surviving group is client-owned", () => {
    const out = dropZeroGroups([
      booth("Client Booth", [group("Client Supplied", 0, [item("Client's own monitors", 0, true)])]),
    ]);
    expect(out).toHaveLength(1);
  });

  it("leaves a document with nothing at $0 exactly as it was", () => {
    const groups = [booth("A", [group("Custom Build", 100)])];
    expect(dropZeroGroups(groups)).toEqual(groups);
  });
});
