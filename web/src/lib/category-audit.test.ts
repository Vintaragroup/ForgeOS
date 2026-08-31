import { describe, expect, it } from "vitest";
import { auditLineItemCategories } from "@/lib/category-audit";

function section(name: string, lineItems: { id: string; description: string; category: string | null }[], groupLabel: string | null = null) {
  return { name, groupLabel, lineItems };
}

// "_x"-suffixed keys deliberately avoid the 5 real Type keys that support
// a Rental/Purchase/Custom Fabricated split (structure/flooring/
// furniture/audio_visual/misc) -- these fixtures are only exercising the
// uncategorized/orphaned checks, not the separate, soft method-unresolved
// one (see its own describe block below), so a real split key here would
// add an unrelated, confusing side effect to every assertion.
describe("auditLineItemCategories", () => {
  it("flags a null category as uncategorized", () => {
    const sections = [section("Booth Build", [{ id: "1", description: "Water-permeable roof", category: null }])];
    const result = auditLineItemCategories(sections, [{ name: "Structure", key: "structure_x" }]);
    expect(result.isClean).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ lineItemId: "1", reason: "uncategorized", category: null }),
    ]);
  });

  it("flags a non-null category that matches no live category as orphaned", () => {
    // Exactly the bug this feature closes: a category was renamed/deleted
    // out from under an already-written LineItem.
    const sections = [section("Booth Build", [{ id: "1", description: "Complete Booth Build", category: "Custom Build" }])];
    const result = auditLineItemCategories(sections, [{ name: "Custom Build / Rental", key: "custom_build" }]);
    expect(result.isClean).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ lineItemId: "1", reason: "orphaned", category: "Custom Build" }),
    ]);
  });

  it("never flags a line item explicitly and correctly filed under the real 'Other' category", () => {
    const sections = [
      section("Add-Ons & Alternates", [{ id: "1", description: "Or other proprietary system", category: "Other" }]),
    ];
    const result = auditLineItemCategories(sections, [{ name: "Other", key: "other" }]);
    expect(result.isClean).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("is clean when every line item resolves to a live category", () => {
    const sections = [
      section("Booth Build", [
        { id: "1", description: "36 x 84\" Compliant Door", category: "Structure" },
        { id: "2", description: "Complete Booth Build", category: "Custom Build / Rental" },
      ]),
    ];
    const result = auditLineItemCategories(sections, [
      { name: "Structure", key: "structure_x" },
      { name: "Custom Build / Rental", key: "custom_build" },
    ]);
    expect(result.isClean).toBe(true);
  });

  it("carries the section name and groupLabel through onto each issue", () => {
    const sections = [
      section("Booth Build", [{ id: "1", description: "Water-permeable roof", category: null }], "Section 203 - Camera Booth - Page 2 & 3"),
    ];
    const result = auditLineItemCategories(sections, []);
    expect(result.issues[0]).toMatchObject({
      sectionName: "Booth Build",
      groupLabel: "Section 203 - Camera Booth - Page 2 & 3",
    });
  });

  it("scans every section passed in, across multiple sections", () => {
    const sections = [
      section("Booth Build", [{ id: "1", description: "A", category: null }]),
      section("Platform", [{ id: "2", description: "B", category: "Flooring" }]),
      section("Other Section", [{ id: "3", description: "C", category: "Nonexistent" }]),
    ];
    const result = auditLineItemCategories(sections, [{ name: "Flooring", key: "flooring_x" }]);
    expect(result.issues.map((i) => i.lineItemId)).toEqual(["1", "3"]);
  });
});

describe("auditLineItemCategories: method-unresolved (soft, non-blocking)", () => {
  it("flags a line item sitting on a flat, split-capable Type category", () => {
    const sections = [
      section("Booth Build", [{ id: "1", description: "BeMatrix Frame 2418mm", category: "Structure" }]),
    ];
    const result = auditLineItemCategories(sections, [{ name: "Structure", key: "structure" }]);
    // Soft: doesn't block sending -- isClean/issues track only the hard
    // uncategorized/orphaned failures, unchanged by this check.
    expect(result.isClean).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.methodUnresolvedIssues).toEqual([
      expect.objectContaining({ lineItemId: "1", category: "Structure" }),
    ]);
  });

  it("does not flag a category with no Method split (e.g. Labor)", () => {
    const sections = [section("Booth Build", [{ id: "1", description: "Installation labor", category: "Labor" }])];
    const result = auditLineItemCategories(sections, [{ name: "Labor", key: "labor" }]);
    expect(result.methodUnresolvedIssues).toEqual([]);
  });

  it("does not flag an item already resolved to a Type-Method leaf", () => {
    const sections = [
      section("Booth Build", [{ id: "1", description: "BeMatrix Frame 2418mm", category: "Structure - Rental" }]),
    ];
    const result = auditLineItemCategories(sections, [
      { name: "Structure", key: "structure" },
      { name: "Structure - Rental", key: "structure_rental" },
    ]);
    expect(result.methodUnresolvedIssues).toEqual([]);
  });
});
