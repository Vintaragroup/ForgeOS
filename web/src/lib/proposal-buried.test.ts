import { Prisma } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { foldBuriedSections, type ProposalViewSection } from "@/lib/proposal-view-model";

const d = (n: number) => new Prisma.Decimal(n);

function item(id: string, totalCost: number, over: Record<string, unknown> = {}) {
  return {
    id,
    description: id,
    category: null,
    isClientOwned: false,
    qty: d(1),
    unit: null,
    totalCost: d(totalCost),
    sortOrder: 0,
    ...over,
  };
}

function section(name: string, groupLabel: string | null, cost: number, over: Partial<ProposalViewSection> = {}): ProposalViewSection {
  return {
    name,
    groupLabel,
    lineItems: [item(`${name}-1`, cost)],
    ...over,
  } as ProposalViewSection;
}

const cost = (s: ProposalViewSection) => s.lineItems.reduce((n, li) => n + Number(li.totalCost), 0);

describe("foldBuriedSections", () => {
  // ABC Chicago's FS - Hitting Bay Wall: $10,351 Custom Build and $2,445
  // Graphics shown, $4,458 Labor and $2,100 Shipping buried.
  const booth = [
    section("Custom Build", "FS - Hitting Bay Wall", 10351),
    section("Graphics", "FS - Hitting Bay Wall", 2445),
    section("Labor", "FS - Hitting Bay Wall", 4458.15, { omittedFromProposal: true }),
    section("Shipping", "FS - Hitting Bay Wall", 2100, { omittedFromProposal: true }),
  ];

  it("moves buried money into the largest visible section of its own booth", () => {
    const out = foldBuriedSections(booth);
    expect(out.map((s) => s.name)).toEqual(["Custom Build", "Graphics"]);

    const target = out.find((s) => s.name === "Custom Build")!;
    expect(cost(target)).toBeCloseTo(10351 + 4458.15 + 2100, 2);
    // Graphics is untouched -- only the largest absorbs.
    expect(cost(out.find((s) => s.name === "Graphics")!)).toBe(2445);
  });

  // The whole point: what the page adds up to must not change when money
  // moves between sections of it.
  it("keeps the document's total cost exactly the same", () => {
    const before = booth.filter((s) => !s.excludedFromTotals).reduce((n, s) => n + cost(s), 0);
    const after = foldBuriedSections(booth).reduce((n, s) => n + cost(s), 0);
    expect(after).toBeCloseTo(before, 2);
  });

  it("marks the moved rows so they are never printed", () => {
    const target = foldBuriedSections(booth).find((s) => s.name === "Custom Build")!;
    const moved = target.lineItems.filter((li) => li.buried);
    expect(moved).toHaveLength(2);
    expect(target.lineItems.filter((li) => !li.buried)).toHaveLength(1);
  });

  it("falls back to the largest visible section anywhere when its booth has none", () => {
    const out = foldBuriedSections([
      section("Big", "SS - Lounge", 9000),
      section("Small", "SS - Lounge", 100),
      section("Labor", "FS - Orphan Booth", 500, { omittedFromProposal: true }),
    ]);
    expect(cost(out.find((s) => s.name === "Big")!)).toBe(9500);
  });

  // Rather than invent a home for it.
  it("leaves a burial alone when the document has nothing visible", () => {
    const only = [section("Labor", "FS - X", 500, { omittedFromProposal: true })];
    expect(foldBuriedSections(only)).toEqual(only);
  });

  // One burial finding a home must not delete another that did not.
  it("keeps a homeless burial even when a different one was re-homed", () => {
    const out = foldBuriedSections([
      section("Custom Build", "FS - A", 1000),
      section("Labor", "FS - A", 200, { omittedFromProposal: true }),
      section("Excluded home", "FS - B", 50, { includeInProposal: false }),
    ]);
    // FS - B's only section is excluded, so nothing there is a target;
    // the FS - A burial still lands.
    expect(cost(out.find((s) => s.name === "Custom Build")!)).toBe(1200);
  });

  it("does nothing at all when nothing is buried", () => {
    const plain = [section("Custom Build", "FS - A", 1000)];
    expect(foldBuriedSections(plain)).toBe(plain);
  });

  // A section excluded outright is gone, not buried -- its money must
  // not be re-homed.
  it("never re-homes an excluded section", () => {
    const out = foldBuriedSections([
      section("Custom Build", "FS - A", 1000),
      section("Gone", "FS - A", 700, { includeInProposal: false }),
    ]);
    expect(cost(out.find((s) => s.name === "Custom Build")!)).toBe(1000);
    expect(out.find((s) => s.name === "Gone")).toBeDefined();
  });
});
