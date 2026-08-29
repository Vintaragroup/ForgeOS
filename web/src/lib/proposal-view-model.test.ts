import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { aggregateByCategory, type ProposalViewSection } from "@/lib/proposal-view-model";

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
