import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { buildTypeTotals } from "@/lib/type-totals";

function cat(name: string, key: string, parentId: string | null = null) {
  return { id: key, name, key, parentId } as never;
}

function li(overrides: Partial<{
  id: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  description: string;
  category: string | null;
  unit: string | null;
  qty: number;
  totalCost: number;
  isDraft: boolean;
  isClientOwned: boolean;
}>) {
  return {
    id: overrides.id ?? "li1",
    lineType: overrides.lineType ?? "MATERIAL",
    description: overrides.description ?? "Item",
    category: overrides.category ?? "Structure",
    unit: overrides.unit ?? "EA",
    qty: new Prisma.Decimal(overrides.qty ?? 1),
    totalCost: new Prisma.Decimal(overrides.totalCost ?? 100),
    isDraft: overrides.isDraft ?? false,
    isClientOwned: overrides.isClientOwned ?? false,
  } as never;
}

const categories = [cat("Structure", "structure"), cat("Labor", "labor")];

describe("buildTypeTotals", () => {
  it("merges the same rented part across two different booths into one summed quantity", () => {
    const sections = [
      { groupLabel: "SECTION 211", buildType: null, lineItems: [li({ id: "a", description: "2418mm x 310mm bematrix Frame", qty: 4, totalCost: 400 })] },
      { groupLabel: "SECTION 428", buildType: null, lineItems: [li({ id: "b", description: "2418mm x 310mm bematrix Frame", qty: 6, totalCost: 600 })] },
    ];

    const [structure] = buildTypeTotals(sections, categories);

    expect(structure.rental.parts).toHaveLength(1);
    expect(structure.rental.parts[0].qty).toBe(10);
    expect(structure.rental.totalCost).toBe(1000);
    expect(structure.totalCost).toBe(1000);
  });

  it("keeps two compound-assembly instances separate even with identical text", () => {
    const sections = [
      {
        groupLabel: null,
        buildType: null,
        lineItems: [
          li({ id: "a", description: "Complete Booth Build\n12' x 7' booth", qty: 1, totalCost: 5000 }),
          li({ id: "b", description: "Complete Booth Build\n12' x 7' booth", qty: 1, totalCost: 6000 }),
        ],
      },
    ];

    const [structure] = buildTypeTotals(sections, categories);
    const parts = [...structure.rental.parts, ...structure.purchase.parts];

    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.totalCost).sort()).toEqual([5000, 6000]);
  });

  it("excludes draft and client-owned items", () => {
    const sections = [
      {
        groupLabel: null,
        buildType: null,
        lineItems: [
          li({ id: "a", description: "bematrix Frame", isDraft: true }),
          li({ id: "b", description: "bematrix Frame", isClientOwned: true }),
          li({ id: "c", description: "bematrix Frame", qty: 3 }),
        ],
      },
    ];

    const [structure] = buildTypeTotals(sections, categories);

    expect(structure.rental.parts).toHaveLength(1);
    expect(structure.rental.parts[0].qty).toBe(3);
  });

  it("excludes LABOR and FEE lines", () => {
    const sections = [
      {
        groupLabel: null,
        buildType: null,
        lineItems: [
          li({ id: "a", lineType: "LABOR", description: "Installation", category: "Labor" }),
          li({ id: "b", lineType: "FEE", description: "Design fee", category: "Labor" }),
          li({ id: "c", lineType: "MATERIAL", description: "bematrix Frame" }),
        ],
      },
    ];

    const totals = buildTypeTotals(sections, categories);

    expect(totals).toHaveLength(1);
    expect(totals[0].categoryName).toBe("Structure");
  });

  it("omits a Type with no qualifying parts entirely, rather than an empty group", () => {
    const sections = [{ groupLabel: null, buildType: null, lineItems: [li({ id: "a", isDraft: true })] }];

    const totals = buildTypeTotals(sections, categories);

    expect(totals).toHaveLength(0);
  });

  describe("Rental vs. Purchase classification", () => {
    it("classifies a bematrix item as Rental purely from its description, even on an untagged booth", () => {
      const sections = [{ groupLabel: null, buildType: null, lineItems: [li({ description: "310mm x 2418mm bematrix Post" })] }];

      const [structure] = buildTypeTotals(sections, categories);

      expect(structure.rental.parts).toHaveLength(1);
      expect(structure.purchase.parts).toHaveLength(0);
    });

    it("does not misclassify an item as Rental just because its own flat category's display name contains the word 'Rental'", () => {
      // Confirmed against real data: the seeded flat category "Custom
      // Build / Rental" (key: custom_build) has that word baked into its
      // display name for unrelated historical reasons. An untagged item
      // filed under it, with no rental signal of its own, must still
      // default to Purchase.
      const sections = [
        { groupLabel: null, buildType: null, lineItems: [li({ description: "Eight portrait commercial touchscreen monitors", category: "Custom Build / Rental" })] },
      ];

      const totals = buildTypeTotals(sections, [...categories, cat("Custom Build / Rental", "custom_build")]);
      const [customBuild] = totals;

      expect(customBuild.categoryName).toBe("Custom Build / Rental");
      expect(customBuild.purchase.parts).toHaveLength(1);
      expect(customBuild.rental.parts).toHaveLength(0);
    });

    it("classifies an item explicitly hand-set to a Method leaf category (not just a booth tag) accordingly", () => {
      const rentalLeaf = cat("Structure - Rental", "structure_rental", "structure");
      const sections = [{ groupLabel: null, buildType: null, lineItems: [li({ description: "Generic platform section", category: "Structure - Rental" })] }];

      const totals = buildTypeTotals(sections, [...categories, rentalLeaf]);

      const flat = totals.flatMap((t) => t.rental.parts);
      expect(flat).toHaveLength(1);
    });

    it("classifies a raw fabrication input (plywood) with no rental signal as Purchase", () => {
      const sections = [{ groupLabel: null, buildType: null, lineItems: [li({ description: "3/4in plywood sheet", category: "Custom Build" })] }];

      const totals = buildTypeTotals(sections, [...categories, cat("Custom Build", "custom_build")]);
      const [customBuild] = totals;

      expect(customBuild.categoryName).toBe("Custom Build");
      expect(customBuild.purchase.parts).toHaveLength(1);
      expect(customBuild.rental.parts).toHaveLength(0);
    });

    it("lets an explicit Rental booth tag win even without a rental keyword in the description", () => {
      const sections = [
        {
          groupLabel: "SECTION 1",
          buildType: "RENTAL" as const,
          lineItems: [li({ description: "Generic platform section", category: "Structure" })],
        },
      ];

      const [structure] = buildTypeTotals(sections, categories);

      expect(structure.rental.parts).toHaveLength(1);
    });

    it("classifies an explicit Custom Fabricated booth tag as Purchase", () => {
      const sections = [
        {
          groupLabel: "SECTION 1",
          buildType: "CUSTOM_BUILD" as const,
          lineItems: [li({ description: "Generic platform section", category: "Structure" })],
        },
      ];

      const [structure] = buildTypeTotals(sections, categories);

      expect(structure.purchase.parts).toHaveLength(1);
      expect(structure.rental.parts).toHaveLength(0);
    });
  });
});
