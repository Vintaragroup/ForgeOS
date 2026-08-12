import { describe, expect, it } from "vitest";
import {
  CUSTOM_BUILD_CATEGORY_KEY,
  inferCategoryFromDescription,
  isKnownCategory,
  mapCatalogCategoryToCanonical,
  resolveCategoryNameFromKey,
  resolveLineItemCategory,
} from "@/lib/line-item-category";

// Minimal in-memory stand-ins -- these functions are pure and only ever
// read `key`/`name`/`parentId` off whatever's passed in, so a real
// Category row from Postgres isn't needed to exercise them.
function cat(name: string, key: string) {
  return { name, key };
}

describe("resolveCategoryNameFromKey", () => {
  it("returns the live name for a matching key", () => {
    const categories = [cat("Structure", "structure"), cat("Custom Build / Rental", "custom_build")];
    expect(resolveCategoryNameFromKey(categories, "custom_build")).toBe("Custom Build / Rental");
  });

  it("returns null when no live category holds that key", () => {
    expect(resolveCategoryNameFromKey([cat("Structure", "structure")], "custom_build")).toBeNull();
  });
});

describe("rename regression: a heuristic's resolved name follows a live rename", () => {
  it("mapCatalogCategoryToCanonical resolves to the CURRENT name, not whatever it was called before a rename", () => {
    // Simulates exactly what happened on a real job: "Custom Build" was
    // renamed to "Custom Build / Rental" -- key stays "custom_build"
    // throughout, only `name` changes.
    const beforeRename = [cat("Custom Build", "custom_build")];
    const afterRename = [cat("Custom Build / Rental", "custom_build")];

    expect(mapCatalogCategoryToCanonical("electrical", beforeRename)).toBe("Custom Build");
    expect(mapCatalogCategoryToCanonical("electrical", afterRename)).toBe("Custom Build / Rental");
  });

  it("inferCategoryFromDescription resolves to the CURRENT name for a compound-build pattern match", () => {
    const beforeRename = [cat("Custom Build", "custom_build")];
    const afterRename = [cat("Custom Build / Rental", "custom_build")];
    const description = "Complete Booth Build 12' x 7' booth";

    expect(inferCategoryFromDescription(description, beforeRename)).toBe("Custom Build");
    expect(inferCategoryFromDescription(description, afterRename)).toBe("Custom Build / Rental");
  });

  it("resolveLineItemCategory's compound-assembly override also follows the rename", () => {
    const afterRename = [cat("Custom Build / Rental", "custom_build")];
    const result = resolveLineItemCategory(
      { description: "Complete Booth Build\n12' x 7' booth\n8' high back & sides" },
      afterRename,
    );
    expect(result).toBe("Custom Build / Rental");
  });

  it("resolves to null, not a stale name, when the key has no live match (category deleted)", () => {
    const noCustomBuild = [cat("Structure", "structure")];
    expect(resolveCategoryNameFromKey(noCustomBuild, CUSTOM_BUILD_CATEGORY_KEY)).toBeNull();
    expect(mapCatalogCategoryToCanonical("electrical", noCustomBuild)).toBeNull();
  });
});

describe("resolveLineItemCategory", () => {
  it("prefers an explicit choice that matches a live category", () => {
    const categories = [cat("Labor", "labor"), cat("Structure", "structure")];
    expect(resolveLineItemCategory({ explicit: "Labor", description: "Plywood" }, categories)).toBe("Labor");
  });

  it("ignores an explicit value that isn't a live category and falls through to the heuristics", () => {
    const categories = [cat("Labor", "labor")];
    expect(resolveLineItemCategory({ explicit: "Nonexistent", description: "Installation labor" }, categories)).toBe(
      "Labor",
    );
  });

  it("falls back to the description heuristic when nothing else resolves", () => {
    const categories = [cat("Structure", "structure")];
    expect(resolveLineItemCategory({ description: "36 x 84\" Compliant Door" }, categories)).toBe("Structure");
  });

  it("returns null (not a guess) when categories is empty -- the safe, audit-catchable failure mode", () => {
    expect(resolveLineItemCategory({ description: "Complete Booth Build\n12' x 7'" })).toBeNull();
  });
});

describe("isKnownCategory", () => {
  it("matches by exact live name", () => {
    expect(isKnownCategory([cat("Other", "other")], "Other")).toBe(true);
  });

  it("returns false for a stale/orphaned name no live category holds", () => {
    expect(isKnownCategory([cat("Other", "other")], "Custom Build")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isKnownCategory([cat("Other", "other")], null)).toBe(false);
    expect(isKnownCategory([cat("Other", "other")], undefined)).toBe(false);
  });
});
