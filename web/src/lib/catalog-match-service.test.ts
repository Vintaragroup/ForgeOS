import { describe, expect, it } from "vitest";
import { matchDescription, type CatalogEntry } from "@/lib/catalog-match-service";

const catalog: CatalogEntry[] = [
  { source: "Material", name: "3/4\" MDF Sheet", unitCost: 55 },
  { source: "Material", name: "1.5\" Aluminum Extrusion, Exhibit Frame Grade", unitCost: 4.5 },
  { source: "Rental", name: "Doors", unitCost: 150 },
  { source: "Rental", name: "Frames", unitCost: 100 },
  { source: "Rental", name: "Flooring — per square foot", unitCost: 4.9 },
];

describe("matchDescription", () => {
  it("matches a plural catalog name against a real RFP line description", () => {
    const match = matchDescription("36 x 84\" Compliant Door - with Code Keypad", catalog);
    expect(match).toEqual({ source: "Rental", name: "Doors", unitCost: 150 });
  });

  it("matches a multi-word material name only when every one of its words is present", () => {
    const match = matchDescription("3/4\" MDF Sheet for booth walls", catalog);
    expect(match?.name).toBe("3/4\" MDF Sheet");
  });

  it("returns null for a turnkey line description that shares no real vocabulary with the catalog -- the common, expected case", () => {
    const match = matchDescription(
      "Complete Booth Build 12' x 7' booth 8' high back & sides 30\" high temporary wall",
      catalog,
    );
    expect(match).toBeNull();
  });

  it("does not spuriously match a multi-word candidate when only some of its words are present", () => {
    const match = matchDescription("Aluminum panel", catalog);
    expect(match).toBeNull(); // "Aluminum Extrusion, Exhibit Frame Grade" needs ALL its words present
  });

  it("returns null for an empty or punctuation-only description", () => {
    expect(matchDescription("", catalog)).toBeNull();
    expect(matchDescription("---", catalog)).toBeNull();
  });
});
