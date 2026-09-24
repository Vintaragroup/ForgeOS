import { describe, expect, it } from "vitest";
import { diffCostBreakouts } from "@/lib/cost-breakout-diff";
import type { CostBreakoutRow, CostBreakoutSheet } from "@/lib/cost-breakout-reader";

function row(over: Partial<CostBreakoutRow>): CostBreakoutRow {
  return {
    tab: "FS - Sign 3ft10 Qty4",
    block: "OTHER_ITEMS",
    rowNumber: 13,
    description: "LED Driver 8.3A 24V",
    variant: null,
    qty: 5,
    unitCost: 85,
    unit: "Each",
    ...over,
  };
}

function sheet(over: Partial<CostBreakoutSheet> = {}): CostBreakoutSheet {
  return {
    tab: "FS - Sign 3ft10 Qty4",
    title: 'Full Swing - Diamond Sign Logo 3\'10" (Qty 4, Side Walls)',
    rows: [row({})],
    ...over,
  };
}

describe("diffCostBreakouts", () => {
  // The real shape of this job's re-cost: the lighting comes out of the
  // signs by zeroing quantities, not by deleting rows.
  it("reports a quantity taken to zero as a change, with the money", () => {
    const d = diffCostBreakouts([sheet()], [sheet({ rows: [row({ qty: 0 })] })]);
    const change = d.elements[0].changes[0];
    expect(change.kind).toBe("QTY");
    expect(change.previousQty).toBe(5);
    expect(change.currentQty).toBe(0);
    expect(change.costDelta).toBe(-425);
    expect(d.costDelta).toBe(-425);
    expect(d.changedRows).toBe(1);
  });

  it("separates a price change from a quantity change, and reports both together", () => {
    const priced = diffCostBreakouts([sheet()], [sheet({ rows: [row({ unitCost: 60 })] })]);
    expect(priced.elements[0].changes[0].kind).toBe("PRICE");

    const both = diffCostBreakouts([sheet()], [sheet({ rows: [row({ qty: 2, unitCost: 60 })] })]);
    expect(both.elements[0].changes[0].kind).toBe("BOTH");
    expect(both.elements[0].changes[0].costDelta).toBe(120 - 425);
  });

  // An element leaving is thirty decisions, not one, so its rows are
  // listed individually rather than collapsed into a single line.
  it("lists every row of an element that is gone from the revised workbook", () => {
    const d = diffCostBreakouts([sheet({ rows: [row({}), row({ description: "JIGGED 4X8", qty: 1, unitCost: 1050 })] })], []);
    expect(d.elements[0].elementRemoved).toBe(true);
    expect(d.elements[0].changes).toHaveLength(2);
    expect(d.elements[0].changes.every((c) => c.kind === "REMOVED")).toBe(true);
    expect(d.removedRows).toBe(2);
    expect(d.costDelta).toBe(-(425 + 1050));
  });

  // "SS - Lounge Structure" became "FS - Lounge Structure" when the
  // client column was relabelled, and every row underneath is untouched.
  // Matching on the tab name alone would report a whole element deleted
  // and another one added.
  it("follows an element through a client rename", () => {
    const before = sheet({ tab: "SS - Lounge Structure", rows: [row({ tab: "SS - Lounge Structure" })] });
    const after = sheet({ tab: "FS - Lounge Structure", rows: [row({ tab: "FS - Lounge Structure", qty: 3 })] });

    const d = diffCostBreakouts([before], [after]);
    expect(d.elements).toHaveLength(1);
    expect(d.elements[0].elementRemoved).toBe(false);
    expect(d.removedRows).toBe(0);
    expect(d.elements[0].changes[0].kind).toBe("QTY");
    // The label keeps its prefix -- "Lounge Wall Structure" alone does
    // not say whose.
    expect(d.elements[0].tab).toBe("SS - Lounge Structure");
  });

  // The only record that the signs stopped being lit.
  it("reports a changed element title", () => {
    const d = diffCostBreakouts(
      [sheet()],
      [sheet({ title: 'Full Swing - NON LIT Diamond Sign Logo 3\'10" (Qty 4, Side Walls) 091826' })],
    );
    expect(d.elements[0].titleChanged).toBe(true);
    expect(d.elements[0].currentTitle).toContain("NON LIT");
  });

  it("says nothing changed when nothing changed", () => {
    const d = diffCostBreakouts([sheet()], [sheet()]);
    expect(d.elements[0].changes).toEqual([]);
    expect(d.elements[0].titleChanged).toBe(false);
    expect(d.costDelta).toBe(0);
  });

  // "China Birch" is two materials; "shipping" appears twice on one tab.
  // Collapsing them would lose one of each.
  it("keeps two rows that share a description apart", () => {
    const before = sheet({
      rows: [
        row({ block: "SHEET_GOODS", description: "China Birch", variant: '3/4"', unitCost: 46.5, qty: 2 }),
        row({ block: "SHEET_GOODS", description: "China Birch", variant: '1/4"', unitCost: 23, qty: 2 }),
      ],
    });
    const after = sheet({
      rows: [
        row({ block: "SHEET_GOODS", description: "China Birch", variant: '3/4"', unitCost: 46.5, qty: 2 }),
        row({ block: "SHEET_GOODS", description: "China Birch", variant: '1/4"', unitCost: 23, qty: 0 }),
      ],
    });

    const d = diffCostBreakouts([before], [after]);
    expect(d.changedRows).toBe(1);
    expect(d.elements[0].changes[0].variant).toBe('1/4"');
    expect(d.elements[0].changes[0].costDelta).toBe(-46);
  });

  it("pairs repeated descriptions in order rather than collapsing them", () => {
    const before = sheet({ rows: [row({ description: "shipping", qty: 120, unitCost: 1 }), row({ description: "shipping", qty: 120, unitCost: 1 })] });
    const after = sheet({ rows: [row({ description: "shipping", qty: 85, unitCost: 1 }), row({ description: "shipping", qty: 120, unitCost: 1 })] });

    const d = diffCostBreakouts([before], [after]);
    expect(d.changedRows).toBe(1);
    expect(d.removedRows).toBe(0);
  });

  it("treats an element only in the revised workbook as new scope", () => {
    const d = diffCostBreakouts([], [sheet()]);
    expect(d.addedRows).toBe(1);
    expect(d.costDelta).toBe(425);
    expect(d.elements[0].elementRemoved).toBe(false);
  });

  // Biggest mover first: that is the order the decisions get made in.
  it("puts the element that moved most at the top", () => {
    const small = sheet({ tab: "FS - Small", rows: [row({ tab: "FS - Small", qty: 1, unitCost: 100 })] });
    const big = sheet({ tab: "FS - Big", rows: [row({ tab: "FS - Big", qty: 100, unitCost: 100 })] });
    const d = diffCostBreakouts(
      [small, big],
      [sheet({ tab: "FS - Small", rows: [row({ tab: "FS - Small", qty: 1, unitCost: 100 })] }), sheet({ tab: "FS - Big", rows: [] })],
    );
    expect(d.elements[0].tab).toBe("FS - Big");
  });
});
