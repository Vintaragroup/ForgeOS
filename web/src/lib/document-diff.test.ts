import { describe, expect, it } from "vitest";
import { computeDocumentDiff, normalizeDescription, type DiffableRow } from "@/lib/document-diff";

function row(description: string, qty: number, unitCost: number): DiffableRow {
  return { description, qty, unitCost };
}

describe("normalizeDescription", () => {
  it("survives the retyping vendors actually do between revisions", () => {
    // Without this an entire re-quote reads as removed-and-re-added.
    expect(normalizeDescription("  LED Wall  —  30ft ")).toBe(normalizeDescription("led wall — 30ft"));
    expect(normalizeDescription("Rigging labor.")).toBe(normalizeDescription("Rigging labor"));
  });

  it("does not collapse genuinely different lines", () => {
    expect(normalizeDescription("LED Wall 30ft")).not.toBe(normalizeDescription("LED Wall 20ft"));
  });
});

describe("what the vendor dropped", () => {
  it("reports a line that is gone -- the half de-duplication could never see", () => {
    const diff = computeDocumentDiff([row("LED Wall", 1, 30000), row("Spare panels", 4, 500)], [row("LED Wall", 1, 30000)]);
    const removed = diff.rows.filter((r) => r.kind === "REMOVED");
    expect(removed).toHaveLength(1);
    expect(removed[0].description).toBe("Spare panels");
    expect(removed[0].delta).toBe(-2000);
  });

  it("puts removals first, because a dropped line is the likeliest mistake", () => {
    const diff = computeDocumentDiff(
      [row("Kept", 1, 100), row("Dropped", 1, 100)],
      [row("Kept", 1, 150), row("Brand new", 1, 100)],
    );
    expect(diff.rows[0].kind).toBe("REMOVED");
  });
});

describe("what the price did", () => {
  it("catches a changed unit cost, which used to match as a duplicate and vanish", () => {
    const diff = computeDocumentDiff([row("LED Wall", 1, 30000)], [row("LED Wall", 1, 24000)]);
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]).toMatchObject({ kind: "CHANGED", delta: -6000, unitCostChanged: true, qtyChanged: false });
  });

  it("tells a quantity change apart from a price change", () => {
    // Halving the quantity is a different conversation from halving the
    // price, and a row that says only "changed" makes you open both
    // documents to find out which.
    const qty = computeDocumentDiff([row("Panels", 10, 100)], [row("Panels", 5, 100)]);
    expect(qty.rows[0]).toMatchObject({ qtyChanged: true, unitCostChanged: false, delta: -500 });

    const price = computeDocumentDiff([row("Panels", 10, 100)], [row("Panels", 10, 50)]);
    expect(price.rows[0]).toMatchObject({ qtyChanged: false, unitCostChanged: true, delta: -500 });
  });

  it("says nothing about a line that didn't move", () => {
    const diff = computeDocumentDiff([row("Same", 2, 100)], [row("Same", 2, 100)]);
    expect(diff.rows).toHaveLength(0);
    expect(diff.unchangedCount).toBe(1);
  });
});

describe("the number someone is actually chasing", () => {
  it("nets the whole revision, which is what answers 'did they get to $850k?'", () => {
    const diff = computeDocumentDiff(
      [row("LED Wall", 1, 30000), row("Rigging", 1, 10000)],
      [row("LED Wall", 1, 24000), row("Rigging", 1, 10000), row("Extra truss", 1, 1500)],
    );
    expect(diff.previousTotal).toBe(40000);
    expect(diff.currentTotal).toBe(35500);
    expect(diff.netDelta).toBe(-4500);
    expect(diff.changedCount).toBe(1);
    expect(diff.addedCount).toBe(1);
    expect(diff.unchangedCount).toBe(1);
  });
});

describe("duplicate descriptions", () => {
  it("pairs repeats in order instead of collapsing them", () => {
    // Two "Shop Supplies" lines on a quote is normal; treating them as
    // one would invent a removal that never happened.
    const diff = computeDocumentDiff(
      [row("Shop Supplies", 1, 100), row("Shop Supplies", 1, 200)],
      [row("Shop Supplies", 1, 100), row("Shop Supplies", 1, 250)],
    );
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]).toMatchObject({ kind: "CHANGED", delta: 50 });
  });

  it("reports a genuinely dropped repeat", () => {
    const diff = computeDocumentDiff(
      [row("Shop Supplies", 1, 100), row("Shop Supplies", 1, 100)],
      [row("Shop Supplies", 1, 100)],
    );
    expect(diff.rows.filter((r) => r.kind === "REMOVED")).toHaveLength(1);
  });
});

describe("edges", () => {
  it("treats a first document as all additions", () => {
    const diff = computeDocumentDiff([], [row("LED Wall", 1, 30000)]);
    expect(diff.addedCount).toBe(1);
    expect(diff.netDelta).toBe(30000);
  });

  it("treats a withdrawn quote as all removals rather than silence", () => {
    const diff = computeDocumentDiff([row("LED Wall", 1, 30000)], []);
    expect(diff.removedCount).toBe(1);
    expect(diff.netDelta).toBe(-30000);
  });
});

// extractPricedRows lives in document-service (it reads Prisma Json), but
// the rule it encodes is the one worth pinning: a row with no usable
// price is dropped, never counted as free.
describe("rows that carry no price", () => {
  it("would report a whole quote as given away if $0 rows were kept", () => {
    // Scope analysis stores its results in the same field a priced
    // spreadsheet uses, but carries no unitCost. Treating those as $0
    // turns every line into a giveaway -- this asserts what that would
    // look like, which is why the service filters them out instead.
    const asIfZero = computeDocumentDiff(
      [row("LED Wall", 1, 30000), row("Rigging", 1, 10000)],
      [row("LED Wall", 1, 0), row("Rigging", 1, 0)],
    );
    expect(asIfZero.netDelta).toBe(-40000);
    expect(asIfZero.rows.every((r) => r.kind === "CHANGED")).toBe(true);
  });
});
