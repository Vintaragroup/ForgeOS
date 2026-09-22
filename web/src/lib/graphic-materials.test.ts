import { describe, expect, it } from "vitest";
import { MATERIAL_SEEDS, canonicalMaterialName, materialClassOf, normalizeMaterialName } from "@/lib/graphic-materials";
import { classifyMaterial, materialClassIsKnown, TURNAROUND_BUSINESS_DAYS } from "@/lib/graphics-sla";

describe("the seeded vocabulary", () => {
  it("covers every distinct material in the PGA control log", () => {
    // All 20 values the log actually contains.
    const fromTheLog = [
      'PVC (White) - 1/8"', "Fabric (Black-Back)", "Vinyl (White)", 'PVC (Black) - 1/8"', "Vinyl (Black)",
      "Vinyl (RTA)", "PVC (Black) - 6mm", '1" Ultraboard - White', "Fabric (Eco - Gray back)",
      "Acrlyic / Plexi (Frost)", 'Foamboard - 3/16"', "Fabric (Lightbox)", 'FoamBoard - 1/2"',
      'Acrlyic / Plexi (Clear) - 1/2"', 'Acrlyic / Plexi (Milk) - 1/8"', 'Acrlyic / Plexi (Clear) - 3/16"',
      "Sintra", "PVC (White) - 6mm", "Scrim", "Hanging Sign",
    ];
    for (const value of fromTheLog) {
      expect(canonicalMaterialName(value), `${value} should resolve`).not.toBeNull();
    }
  });

  it("has no duplicate names", () => {
    expect(new Set(MATERIAL_SEEDS.map((m) => m.name)).size).toBe(MATERIAL_SEEDS.length);
  });

  it("does not offer a value that describes the piece rather than the substrate", () => {
    // "Hanging Sign" is real history but is not something you print on.
    expect(MATERIAL_SEEDS.find((m) => m.name === "Hanging Sign")?.isActive).toBe(false);
  });
});

describe("canonicalMaterialName", () => {
  it("folds the misspelling that appears on 3 of 5 acrylic rows", () => {
    expect(canonicalMaterialName("Acrlyic / Plexi (Frost)")).toBe("Acrylic / Plexi (Frost)");
    expect(canonicalMaterialName('Acrlyic / Plexi (Clear) - 1/2"')).toBe('Acrylic / Plexi (Clear) - 1/2"');
  });

  it("folds the two capitalisations of Foamboard", () => {
    expect(canonicalMaterialName('FoamBoard - 1/2"')).toBe('Foamboard - 1/2"');
    expect(canonicalMaterialName('foamboard - 1/2"')).toBe('Foamboard - 1/2"');
  });

  it("keeps thicknesses apart -- 1/8\" PVC is not 6mm PVC", () => {
    expect(canonicalMaterialName('PVC (White) - 1/8"')).not.toBe(canonicalMaterialName("PVC (White) - 6mm"));
  });

  it("keeps colours apart", () => {
    expect(canonicalMaterialName("Vinyl (White)")).not.toBe(canonicalMaterialName("Vinyl (Black)"));
  });

  it("returns null for something it doesn't know, rather than inventing a material", () => {
    expect(canonicalMaterialName("Brushed aluminium")).toBeNull();
    expect(canonicalMaterialName("")).toBeNull();
    expect(canonicalMaterialName(null)).toBeNull();
  });
});

describe("normalizeMaterialName", () => {
  it("ignores case and spacing but not the substance", () => {
    expect(normalizeMaterialName("  Vinyl   (White) ")).toBe(normalizeMaterialName("vinyl (white)"));
    expect(normalizeMaterialName("Sintra")).not.toBe(normalizeMaterialName("Scrim"));
  });
});

describe("materialClassOf", () => {
  it("classes the substrates the way the turnaround table needs", () => {
    expect(materialClassOf("Fabric (Black-Back)")).toBe("FABRIC");
    expect(materialClassOf("Scrim")).toBe("FABRIC");
    expect(materialClassOf('PVC (White) - 1/8"')).toBe("RIGID");
    expect(materialClassOf("Hanging Sign")).toBe("HANGING_SIGN");
  });
});

describe("classifyMaterial, now backed by the list", () => {
  it("takes a picked material's class as fact, including a folded misspelling", () => {
    expect(classifyMaterial("Acrlyic / Plexi (Frost)")).toBe("RIGID");
    expect(materialClassIsKnown("Acrlyic / Plexi (Frost)")).toBe(true);
  });

  it("gives a fabric its 5-day turnaround and a hanging sign its 10", () => {
    expect(TURNAROUND_BUSINESS_DAYS[classifyMaterial("Fabric (Lightbox)")]).toBe(5);
    expect(TURNAROUND_BUSINESS_DAYS[classifyMaterial(null, "Hanging Sign")]).toBe(10);
  });

  it("still guesses for free text, but says the guess is a guess", () => {
    expect(classifyMaterial("some new fabric blend")).toBe("FABRIC");
    expect(materialClassIsKnown("some new fabric blend")).toBe(false);
  });

  it("flags a piece with no material -- the 282 Seatrade rows -- as unknown, not as rigid fact", () => {
    expect(classifyMaterial(null)).toBe("RIGID");
    expect(materialClassIsKnown(null)).toBe(false);
  });
});
