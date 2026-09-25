import { Prisma } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { computeVersionTotals } from "@/lib/estimate-service";
import { aggregateByCategory, sellOfItems, type ProposalViewSection } from "@/lib/proposal-view-model";

const d = (n: number) => new Prisma.Decimal(n);

// A 50% margin makes the arithmetic obvious: $100 of cost sells for $200,
// and an at-cost line sells for $100.
const MARGIN = 50;
const categories = [{ id: "c1", name: "Custom Build", key: "custom_build", parentId: null }] as never;
const sellForCategory = (cost: number) => cost * 2;

function item(description: string, totalCost: number, atCost = false) {
  return {
    id: description,
    description,
    category: "Custom Build",
    isClientOwned: false,
    atCost,
    qty: d(1),
    unit: null,
    totalCost: d(totalCost),
    sortOrder: 0,
  };
}

describe("one line priced at cost, among siblings that keep their markup", () => {
  const section = {
    name: "Custom Build",
    groupLabel: "01 Order Writing Counter",
    buildType: "CUSTOM",
    lineItems: [item("Plywood", 100), item("Pass-through freight", 100, true), item("Laminate", 100)],
  } as unknown as ProposalViewSection;

  // The estimate's own total. Margin already resolved per line item here,
  // so this is the same loop deciding one line differently.
  it("grosses up the siblings and leaves the at-cost line alone", () => {
    const totals = computeVersionTotals(
      { marginTargetPct: MARGIN, sections: [section as never] },
      categories,
      new Map(),
    );
    expect(Number(totals.totalCost)).toBe(300);
    // 100*2 + 100 + 100*2 = 500, not 600.
    expect(Number(totals.grandTotal)).toBe(500);
  });

  it("reports the blended margin the job actually earns", () => {
    const totals = computeVersionTotals(
      { marginTargetPct: MARGIN, sections: [section as never] },
      categories,
      new Map(),
    );
    // (500-300)/500 = 40%, not the 50% target -- which is the point of
    // showing it: an at-cost line really does cost margin.
    expect(Number(totals.grossMarginPct)).toBeCloseTo(40, 4);
  });

  // The aggregate price has to be summed row by row. Grossing up the
  // bucket total instead would mark up the very line that was excluded.
  it("does not mark up the at-cost line when a group is totalled", () => {
    const buckets = aggregateByCategory([section], categories);
    const items = buckets[0].items;
    expect(sellOfItems(items, "Custom Build", sellForCategory)).toBe(500);
    // The old shape, kept here to show what it would have produced.
    const grossedUpOnce = sellForCategory(items.reduce((n, li) => n + li.totalCost, 0));
    expect(grossedUpOnce).toBe(600);
  });

  // Two rows that read the same but are priced differently must not
  // collapse into one, or the merged row takes one price for both.
  it("never merges an at-cost row into a marked-up one", () => {
    const mixed = {
      ...section,
      lineItems: [item("Freight", 100), item("Freight", 100, true)],
    } as unknown as ProposalViewSection;
    const items = aggregateByCategory([mixed], categories)[0].items;
    expect(items).toHaveLength(2);
    expect(items.filter((li) => li.atCost)).toHaveLength(1);
    expect(sellOfItems(items, "Custom Build", sellForCategory)).toBe(300);
  });

  it("changes nothing at all when no line is at cost", () => {
    const plain = {
      ...section,
      lineItems: [item("Plywood", 100), item("Laminate", 100)],
    } as unknown as ProposalViewSection;
    const items = aggregateByCategory([plain], categories)[0].items;
    expect(sellOfItems(items, "Custom Build", sellForCategory)).toBe(400);
  });
});
