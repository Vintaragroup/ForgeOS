import { describe, expect, it } from "vitest";
import { auditExcludedFromTotals, slugifyGroupLabel } from "@/lib/excluded-from-totals-audit";

function section(
  groupLabel: string | null,
  excludedFromTotals: boolean,
  lineItems: {
    id: string;
    description: string;
    totalCost: number;
    isDraft?: boolean;
    document?: { id: string; mimeType: string } | null;
    sourceQuote?: string | null;
    sourcePageNumber?: number | null;
  }[],
  createdAt = new Date("2026-08-30T00:00:00Z"),
) {
  return { groupLabel, excludedFromTotals, createdAt, lineItems };
}

describe("auditExcludedFromTotals", () => {
  it("returns nothing when no section is flagged", () => {
    const sections = [section("Bid Comparison", false, [{ id: "1", description: "Rate", totalCost: 100 }])];
    expect(auditExcludedFromTotals(sections, [])).toEqual([]);
  });

  it("groups every section sharing a flagged groupLabel into one issue, summing cost across them", () => {
    const sections = [
      section("Bid Comparison", true, [{ id: "1", description: "Straight Time Rate", totalCost: 20100 }]),
      section("Bid Comparison", true, [{ id: "2", description: "Inbound Shipping", totalCost: 2500 }]),
    ];
    const [issue] = auditExcludedFromTotals(sections, []);
    expect(issue.groupLabel).toBe("Bid Comparison");
    expect(issue.cost).toBe(22600);
    expect(issue.itemCount).toBe(2);
    expect(issue.items.map((i) => i.id).sort()).toEqual(["1", "2"]);
  });

  it("never counts a real booth's non-excluded sections, even sharing the same groupLabel", () => {
    const sections = [
      section("FS - Hitting Bay Wall", true, [{ id: "1", description: "Excluded", totalCost: 100 }]),
      section("FS - Hitting Bay Wall", false, [{ id: "2", description: "Real scope", totalCost: 5000 }]),
    ];
    const [issue] = auditExcludedFromTotals(sections, []);
    expect(issue.cost).toBe(100);
    expect(issue.items.map((i) => i.id)).toEqual(["1"]);
  });

  it("excludes draft line items from cost/count, same as the estimate's own totals", () => {
    const sections = [
      section("Bid Comparison", true, [
        { id: "1", description: "Confirmed", totalCost: 100 },
        { id: "2", description: "Still a draft", totalCost: 9999, isDraft: true },
      ]),
    ];
    const [issue] = auditExcludedFromTotals(sections, []);
    expect(issue.cost).toBe(100);
    expect(issue.itemCount).toBe(1);
  });

  it("finds the actor from the first CREATE audit-log entry among this group's line items", () => {
    const sections = [section("Bid Comparison", true, [{ id: "1", description: "Rate", totalCost: 100 }])];
    const auditLog = [
      { action: "UPDATE", lineItemId: "1", actor: { name: "Someone Else" } },
      { action: "CREATE", lineItemId: "1", actor: { name: "Craig Wells" } },
    ];
    const [issue] = auditExcludedFromTotals(sections, auditLog);
    expect(issue.actorName).toBe("Craig Wells");
  });

  it("defaults actorName to null when the audit log has no CREATE entry for this group -- predates tracking or a bulk import", () => {
    const sections = [section("Bid Comparison", true, [{ id: "1", description: "Rate", totalCost: 100 }])];
    const [issue] = auditExcludedFromTotals(sections, []);
    expect(issue.actorName).toBeNull();
  });

  it("carries citation fields through for an imported line item, and nulls for a manually-typed one", () => {
    const sections = [
      section("Bid Comparison", true, [
        {
          id: "1",
          description: "From a pricing schedule",
          totalCost: 100,
          document: { id: "doc1", mimeType: "application/pdf" },
          sourceQuote: "Straight Time Rate",
          sourcePageNumber: 3,
        },
        { id: "2", description: "Typed directly, no import", totalCost: 200 },
      ]),
    ];
    const [issue] = auditExcludedFromTotals(sections, []);
    const imported = issue.items.find((i) => i.id === "1")!;
    const manual = issue.items.find((i) => i.id === "2")!;
    expect(imported.document).toEqual({ id: "doc1", mimeType: "application/pdf" });
    expect(imported.sourceQuote).toBe("Straight Time Rate");
    expect(imported.sourcePageNumber).toBe(3);
    expect(manual.document).toBeNull();
    expect(manual.sourceQuote).toBeNull();
    expect(manual.sourcePageNumber).toBeNull();
  });

  it("uses the earliest createdAt across every section contributing to the group", () => {
    const sections = [
      section("Bid Comparison", true, [{ id: "1", description: "A", totalCost: 100 }], new Date("2026-09-02T00:00:00Z")),
      section("Bid Comparison", true, [{ id: "2", description: "B", totalCost: 100 }], new Date("2026-08-30T00:00:00Z")),
    ];
    const [issue] = auditExcludedFromTotals(sections, []);
    expect(issue.createdAt).toEqual(new Date("2026-08-30T00:00:00Z"));
  });

  it("returns one issue per distinct flagged groupLabel", () => {
    const sections = [
      section("Bid Comparison", true, [{ id: "1", description: "A", totalCost: 100 }]),
      section("Another Flagged Booth", true, [{ id: "2", description: "B", totalCost: 200 }]),
    ];
    const issues = auditExcludedFromTotals(sections, []);
    expect(issues.map((i) => i.groupLabel).sort()).toEqual(["Another Flagged Booth", "Bid Comparison"]);
  });
});

describe("slugifyGroupLabel", () => {
  it("lowercases and hyphenates a real booth label", () => {
    expect(slugifyGroupLabel("FS - Hitting Bay Wall")).toBe("fs-hitting-bay-wall");
  });

  it("collapses runs of punctuation/whitespace into one hyphen and trims leading/trailing hyphens", () => {
    expect(slugifyGroupLabel("  Bid Comparison!! ")).toBe("bid-comparison");
  });
});
