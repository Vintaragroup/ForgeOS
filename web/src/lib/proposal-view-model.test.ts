import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { aggregateByCategory, groupBoothLineItems, type ProposalViewSection } from "@/lib/proposal-view-model";

function cat(name: string, key: string) {
  return { id: key, name, key, parentId: null, sortOrder: 0, isShowService: false, isLumpSum: false, deletedAt: null } as never;
}

function li(overrides: Partial<{ id: string; description: string; category: string | null; qty: number; unit: string | null; totalCost: number; isClientOwned: boolean; sortOrder: number }>) {
  return {
    id: overrides.id ?? "li1",
    description: overrides.description ?? "Item",
    category: overrides.category ?? "Structure",
    isClientOwned: overrides.isClientOwned ?? false,
    qty: new Prisma.Decimal(overrides.qty ?? 1),
    unit: overrides.unit ?? "EA",
    totalCost: new Prisma.Decimal(overrides.totalCost ?? 100),
    sortOrder: overrides.sortOrder ?? 0,
  };
}

const categories = [cat("Structure", "structure")];

describe("aggregateByCategory -- booth-scoped grouping", () => {
  it("keeps the same part description separate across two different booths instead of merging their pricing", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 211", lineItems: [li({ id: "a", description: "614 x 2418mm Post", qty: 3, totalCost: 327 })] },
      { name: "BeMatrix", groupLabel: "SECTION 428", lineItems: [li({ id: "b", description: "614 x 2418mm Post", qty: 2, totalCost: 218 })] },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(2);
    const bySection = Object.fromEntries(bucket.items.map((i) => [i.boothLabel, i]));
    expect(bySection["SECTION 211"]?.qty).toBe(3);
    expect(bySection["SECTION 211"]?.totalCost).toBe(327);
    expect(bySection["SECTION 428"]?.qty).toBe(2);
    expect(bySection["SECTION 428"]?.totalCost).toBe(218);
  });

  it("still merges duplicate rows of the same part WITHIN one booth", () => {
    const sections: ProposalViewSection[] = [
      {
        name: "BeMatrix",
        groupLabel: "SECTION 428",
        lineItems: [
          li({ id: "a", description: "614 x 2418mm Post", qty: 3, totalCost: 327 }),
          li({ id: "b", description: "614 x 2418mm Post", qty: 1, totalCost: 109 }),
        ],
      },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(1);
    expect(bucket.items[0].qty).toBe(4);
    expect(bucket.items[0].totalCost).toBe(436);
    expect(bucket.items[0].boothLabel).toBe("SECTION 428");
  });

  it("still sums a booth-INDEPENDENT part (no groupLabel) across the whole show, unchanged from before", () => {
    const sections: ProposalViewSection[] = [
      { name: "Add-Ons", groupLabel: null, lineItems: [li({ id: "a", description: "Compliant Door", qty: 1, totalCost: 150 })] },
      { name: "Add-Ons", groupLabel: null, lineItems: [li({ id: "b", description: "Compliant Door", qty: 1, totalCost: 150 })] },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(1);
    expect(bucket.items[0].qty).toBe(2);
    expect(bucket.items[0].totalCost).toBe(300);
    expect(bucket.items[0].boothLabel).toBeNull();
  });

  it("never merges a compound assembly across booths even when they share identical spec text", () => {
    const sections: ProposalViewSection[] = [
      { name: "Booth", groupLabel: "SECTION 203", lineItems: [li({ id: "a", description: "Complete Booth Build\n12' x 7' booth", qty: 1, totalCost: 5000 })] },
      { name: "Booth", groupLabel: "SECTION 211", lineItems: [li({ id: "b", description: "Complete Booth Build\n12' x 7' booth", qty: 1, totalCost: 6000 })] },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(2);
    expect(bucket.items.map((i) => i.totalCost).sort()).toEqual([5000, 6000]);
  });
});

describe("groupBoothLineItems", () => {
  it("groups by booth, then by element type -- keeping BeMatrix (Wall Structure) and Wall Panels (Wall Covering) separate", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 211", lineItems: [li({ id: "a", description: "310mm x 2418mm Frame", qty: 4, totalCost: 1300 })] },
      { name: "Wall Panels", groupLabel: "SECTION 211", lineItems: [li({ id: "b", description: "SEG w/ Blackout White", qty: 6, totalCost: 200, unit: "SQFT" })] },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.boothLabel).toBe("SECTION 211");
    expect(booth.elementGroups.map((g) => g.elementType)).toEqual(["Wall Structure", "Wall Covering"]);
    expect(booth.elementGroups[0].items[0].description).toBe("310mm x 2418mm Frame");
    expect(booth.elementGroups[1].items[0].description).toBe("SEG w/ Blackout White");
    expect(booth.subtotal).toBe(1500);
  });

  it("orders multiple booths by their own label and ignores booth-independent sections entirely", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 428", lineItems: [li({ id: "a", totalCost: 100 })] },
      { name: "BeMatrix", groupLabel: "SECTION 211", lineItems: [li({ id: "b", totalCost: 200 })] },
      { name: "Add-Ons", groupLabel: null, lineItems: [li({ id: "c", totalCost: 9999 })] },
    ];

    const groups = groupBoothLineItems(sections);

    expect(groups.map((g) => g.boothLabel)).toEqual(["SECTION 211", "SECTION 428"]);
    const total = groups.reduce((sum, g) => sum + g.subtotal, 0);
    expect(total).toBe(300); // the $9999 Add-Ons item never contributes -- no groupLabel
  });

  it("falls back to the raw section name for an unmapped element-type category instead of dropping it", () => {
    const sections: ProposalViewSection[] = [
      { name: "Cleaning", groupLabel: "SECTION 211", lineItems: [li({ id: "a", description: "Post-show cleaning", totalCost: 50 })] },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.elementGroups[0].elementType).toBe("Cleaning");
  });

  it("still merges duplicate parts within the same booth+element-type, but never removes a compound assembly's booth label ambiguity across booths", () => {
    const sections: ProposalViewSection[] = [
      {
        name: "BeMatrix",
        groupLabel: "SECTION 428",
        lineItems: [
          li({ id: "a", description: "614 x 2418mm Post", qty: 3, totalCost: 327 }),
          li({ id: "b", description: "614 x 2418mm Post", qty: 1, totalCost: 109 }),
        ],
      },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.elementGroups[0].items).toHaveLength(1);
    expect(booth.elementGroups[0].items[0].qty).toBe(4);
    // The booth is already the group's own heading -- redundant per-item
    // label would just repeat it under every single row.
    expect(booth.elementGroups[0].items[0].boothLabel).toBeNull();
  });
});
