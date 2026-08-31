import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { buildTypeTotals } from "@/lib/type-totals";

function cat(name: string, key: string) {
  return { id: key, name, key, parentId: null } as never;
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
  it("merges the same part across two different booths into one summed quantity", () => {
    const sections = [
      { groupLabel: "SECTION 211", buildType: null, lineItems: [li({ id: "a", description: "2418mm x 310mm Frame", qty: 4, totalCost: 400 })] },
      { groupLabel: "SECTION 428", buildType: null, lineItems: [li({ id: "b", description: "2418mm x 310mm Frame", qty: 6, totalCost: 600 })] },
    ];

    const [structure] = buildTypeTotals(sections, categories);

    expect(structure.parts).toHaveLength(1);
    expect(structure.parts[0].qty).toBe(10);
    expect(structure.parts[0].totalCost).toBe(1000);
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

    expect(structure.parts).toHaveLength(2);
    expect(structure.parts.map((p) => p.totalCost).sort()).toEqual([5000, 6000]);
  });

  it("excludes draft and client-owned items", () => {
    const sections = [
      {
        groupLabel: null,
        buildType: null,
        lineItems: [
          li({ id: "a", description: "Frame", isDraft: true }),
          li({ id: "b", description: "Frame", isClientOwned: true }),
          li({ id: "c", description: "Frame", qty: 3 }),
        ],
      },
    ];

    const [structure] = buildTypeTotals(sections, categories);

    expect(structure.parts).toHaveLength(1);
    expect(structure.parts[0].qty).toBe(3);
  });

  it("excludes LABOR and FEE lines", () => {
    const sections = [
      {
        groupLabel: null,
        buildType: null,
        lineItems: [
          li({ id: "a", lineType: "LABOR", description: "Installation", category: "Labor" }),
          li({ id: "b", lineType: "FEE", description: "Design fee", category: "Labor" }),
          li({ id: "c", lineType: "MATERIAL", description: "Frame" }),
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
});
