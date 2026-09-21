import { describe, expect, it } from "vitest";
import { GRAPHICS_VENDOR_SEEDS, looksLikeAPerson, normalizeVendorName } from "@/lib/graphics-vendors";

describe("normalizeVendorName", () => {
  it("matches the same shop across the two lists' spellings", () => {
    // ForgeOS (from the Orlando control log) vs Gabriella's list.
    expect(normalizeVendorName("Olympus Custom Print (ORLANDO)")).toBe(normalizeVendorName("Olympus - Orlando"));
    expect(normalizeVendorName("SpeedPro (ORLANDO)")).toBe(normalizeVendorName("SpeedPro - Orlando"));
    // Her own data spells this one two ways.
    expect(normalizeVendorName("ORBUS")).toBe(normalizeVendorName("Orbus - Orlando"));
  });

  it("matches the duplicate Riot rows to each other", () => {
    expect(normalizeVendorName("RIOt")).toBe(normalizeVendorName("Riot (ORLANDO)"));
  });

  it("ignores a company-form suffix", () => {
    expect(normalizeVendorName("Procedes llc")).toBe(normalizeVendorName("Procedes LLC"));
  });

  it("keeps genuinely different shops apart", () => {
    const distinct = ["A3Visual - Miami/Cali/Vegas", "Binca - Miami", "Binick Imaginig - Miami", "DTP - Vegas/Utah"];
    const normalized = distinct.map(normalizeVendorName);
    expect(new Set(normalized).size).toBe(distinct.length);
  });

  it("does not collapse Binca and Binick, which differ only after the prefix", () => {
    expect(normalizeVendorName("Binca - Miami")).not.toBe(normalizeVendorName("Binick Imaginig - Miami"));
  });
});

describe("GRAPHICS_VENDOR_SEEDS", () => {
  it("has no duplicate names or initials", () => {
    expect(new Set(GRAPHICS_VENDOR_SEEDS.map((v) => v.name)).size).toBe(GRAPHICS_VENDOR_SEEDS.length);
    expect(new Set(GRAPHICS_VENDOR_SEEDS.map((v) => v.initials)).size).toBe(GRAPHICS_VENDOR_SEEDS.length);
  });

  it("no two seeds normalize to the same vendor", () => {
    const normalized = GRAPHICS_VENDOR_SEEDS.map((v) => normalizeVendorName(v.name));
    expect(new Set(normalized).size).toBe(GRAPHICS_VENDOR_SEEDS.length);
  });

  it("marks exactly the seven shops the Seatrade export actually used", () => {
    expect(GRAPHICS_VENDOR_SEEDS.filter((v) => v.seenInUse).map((v) => v.name).sort()).toEqual([
      "A3Visual - Miami/Cali/Vegas",
      "Binca - Miami",
      "Binick Imaginig - Miami",
      "DTP - Vegas/Utah",
      "Orbus - Orlando",
      "Procedes llc",
      "Sir Speed Signs - Miami",
    ]);
  });
});

describe("looksLikeAPerson", () => {
  it("flags a vendor row that is really someone's name", () => {
    expect(looksLikeAPerson("Connor Edson")).toBe(true);
  });

  it("leaves real shops alone", () => {
    for (const name of ["Orlando Large Format Printing", "Binca - Miami", "Procedes llc", "EXPO - Orlando", "ORBUS"]) {
      expect(looksLikeAPerson(name)).toBe(false);
    }
  });
});
