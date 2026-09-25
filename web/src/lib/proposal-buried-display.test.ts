import { Prisma } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import {
  attachBuriedDisplay,
  buriedDisplayCategory,
  buriedDisplayPlan,
  type ElementGroup,
  type ProposalViewSection,
} from "@/lib/proposal-view-model";

const d = (n: number) => new Prisma.Decimal(n);

// Only the fields these three functions actually read.
const categories = [
  { id: "c1", name: "Custom Build", key: "custom_build", parentId: null },
  { id: "c2", name: "Shipping", key: "shipping", parentId: null },
  { id: "c3", name: "Professional Services", key: "professional_services", parentId: null },
] as never;

function section(
  name: string,
  groupLabel: string | null,
  category: string,
  cost: number,
  over: Partial<ProposalViewSection> = {},
): ProposalViewSection {
  return {
    name,
    groupLabel,
    buildType: groupLabel ? "CUSTOM" : null,
    proposalSortOrder: 0,
    lineItems: [
      { id: `${name}-1`, description: name, category, isClientOwned: false, qty: d(1), unit: null, totalCost: d(cost), sortOrder: 0 },
    ],
    ...over,
  } as ProposalViewSection;
}

// A flat 25% margin, which is all these tests need to tell cost from price.
const sell = (cost: number) => cost / 0.75;
const showServices = new Set(["Shipping"]);

describe("buriedDisplayPlan", () => {
  // The eleven sections on ABC Chicago: each one booth's own Labor or
  // Shipping, buried so the booth quotes as a single price.
  it("sends an element's buried money back to that element, keyed by its own category", () => {
    const plan = buriedDisplayPlan(
      [
        section("Custom Build", "FS - Hitting Bay Wall", "Custom Build", 10351),
        section("Labor", "FS - Hitting Bay Wall", "Custom Build", 4458.15, { omittedFromProposal: true }),
      ],
      categories,
      sell,
      showServices,
    );
    expect(plan.byBooth.get("Custom Build::FS - Hitting Bay Wall")).toEqual({
      cost: 4458.15,
      sell: sell(4458.15),
    });
    expect(plan.unhomedRental).toEqual({ cost: 0, sell: 0 });
  });

  // Showing rental money inside a show-service bar made "Rental components
  // total" and "Show services total" disagree with the bars above them.
  it("keeps unhomed money on its own side of the rental/services line", () => {
    const plan = buriedDisplayPlan(
      [
        section("Professional Services", null, "Professional Services", 7371.6, { omittedFromProposal: true }),
        section("Show Services Shipping", null, "Shipping", 7250, { omittedFromProposal: true }),
      ],
      categories,
      sell,
      showServices,
    );
    expect(plan.unhomedRental).toEqual({ cost: 7371.6, sell: sell(7371.6) });
    expect(plan.unhomedService).toEqual({ cost: 7250, sell: sell(7250) });
  });

  it("ignores a section that was removed rather than buried", () => {
    const plan = buriedDisplayPlan(
      [
        section("Gone", null, "Custom Build", 500, { omittedFromProposal: true, includeInProposal: false }),
        section("Also gone", null, "Custom Build", 900, { omittedFromProposal: true, excludedFromTotals: true }),
      ],
      categories,
      sell,
      showServices,
    );
    expect(plan.unhomedRental).toEqual({ cost: 0, sell: 0 });
  });

  it("has nothing to show when nothing is buried", () => {
    const plan = buriedDisplayPlan([section("Custom Build", "B", "Custom Build", 100)], categories, sell, showServices);
    expect(plan.byBooth.size).toBe(0);
  });
});

describe("buriedDisplayCategory", () => {
  it("names the marked section's own category, by money", () => {
    const marked = section("Show Site Supervision", null, "Professional Services", 4318, {
      absorbsBuriedCost: true,
    });
    expect(buriedDisplayCategory([marked], categories)).toBe("Professional Services");
  });

  it("is null when nobody has said where buried money should show", () => {
    expect(buriedDisplayCategory([section("A", null, "Custom Build", 10)], categories)).toBeNull();
  });

  it("never lets two marked sections show the same money twice", () => {
    const first = section("First", null, "Professional Services", 100, { absorbsBuriedCost: true, proposalSortOrder: 1 });
    const second = section("Second", null, "Custom Build", 999, { absorbsBuriedCost: true, proposalSortOrder: 2 });
    expect(buriedDisplayCategory([second, first], categories)).toBe("Professional Services");
  });
});

describe("attachBuriedDisplay", () => {
  const element = (elementLabel: string, subtotal: number): ElementGroup => ({
    elementLabel,
    boothDescription: null,
    subtotal,
    summarizeOnProposal: true,
    boothSummary: null,
    tradeGroups: [
      { tradeCategory: "Custom Build", items: [], subgroups: [], subtotal, elementSummary: null, summarizeOnProposal: true },
    ],
  });

  const emptyPlan = { byBooth: new Map(), unhomedRental: { cost: 0, sell: 0 }, unhomedService: { cost: 0, sell: 0 } };

  it("hangs an element's own buried money on that element", () => {
    const plan = {
      ...emptyPlan,
      byBooth: new Map([["Custom Build::B", { cost: 100, sell: 133.33 }]]),
    };
    const out = attachBuriedDisplay([element("A", 900), element("B", 200)], "Custom Build", plan, { cost: 0, sell: 0 });
    expect(out.find((b) => b.elementLabel === "B")!.buriedSell).toBe(133.33);
    expect(out.find((b) => b.elementLabel === "A")!.buriedSell).toBeUndefined();
  });

  it("puts unhomed money on the biggest element, and on its biggest trade", () => {
    const out = attachBuriedDisplay([element("Small", 200), element("Big", 900)], "Custom Build", emptyPlan, {
      cost: 500,
      sell: 666.67,
    });
    const big = out.find((b) => b.elementLabel === "Big")!;
    expect(big.buriedCost).toBe(500);
    expect(big.tradeGroups[0].buriedCost).toBe(500);
    expect(out.find((b) => b.elementLabel === "Small")!.buriedCost).toBeUndefined();
  });

  // The subtotal is what every other number is summed from; only the
  // printed figure is meant to grow.
  it("never changes an element's own subtotal or items", () => {
    const before = [element("A", 900)];
    const out = attachBuriedDisplay(before, "Custom Build", emptyPlan, { cost: 500, sell: 666.67 });
    expect(out[0].subtotal).toBe(900);
    expect(out[0].tradeGroups[0].subtotal).toBe(900);
  });

  it("leaves a category with nothing buried exactly as it was", () => {
    const before = [element("A", 900)];
    expect(attachBuriedDisplay(before, "Custom Build", emptyPlan, { cost: 0, sell: 0 })).toEqual(before);
  });
});
