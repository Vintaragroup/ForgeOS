import { describe, expect, it } from "vitest";
import { describeSection, overlappingSection, parseBoothNumber, sectionForBooth } from "@/lib/show-section";

// The four sections on the Seatrade April 2026 show, as her tracker
// labels them.
const SEATRADE = [
  { id: "1", name: "Section 1", boothStart: 100, boothEnd: 699 },
  { id: "2", name: "Section 2", boothStart: 700, boothEnd: 1299 },
  { id: "3", name: "Section 3", boothStart: 1300, boothEnd: 1799 },
  { id: "4", name: "Section 4", boothStart: 1800, boothEnd: 2299 },
];

describe("parseBoothNumber", () => {
  it("reads a plain booth number", () => {
    expect(parseBoothNumber("1585")).toBe(1585);
    expect(parseBoothNumber("  445 ")).toBe(445);
  });

  it("refuses the non-numeric values her Booth column actually holds", () => {
    // 172 of 282 Seatrade rows are "SM" or "sm" -- show management, not a
    // place on the floor.
    expect(parseBoothNumber("SM")).toBeNull();
    expect(parseBoothNumber("sm")).toBeNull();
    expect(parseBoothNumber("")).toBeNull();
    expect(parseBoothNumber(null)).toBeNull();
  });

  it("refuses a suffixed booth rather than guessing which side of a boundary it falls on", () => {
    expect(parseBoothNumber("1585A")).toBeNull();
    expect(parseBoothNumber("8A/8B")).toBeNull();
  });
});

describe("sectionForBooth", () => {
  it("places the real booths from the export in their stated sections", () => {
    // Each of these appears in the Seatrade export with this section.
    expect(sectionForBooth(SEATRADE, "1585")?.name).toBe("Section 3");
    expect(sectionForBooth(SEATRADE, "445")?.name).toBe("Section 1");
    expect(sectionForBooth(SEATRADE, "1045")?.name).toBe("Section 2");
    expect(sectionForBooth(SEATRADE, "1901")?.name).toBe("Section 4");
  });

  it("includes both ends of a range", () => {
    expect(sectionForBooth(SEATRADE, "700")?.name).toBe("Section 2");
    expect(sectionForBooth(SEATRADE, "1299")?.name).toBe("Section 2");
  });

  it("returns null for a booth outside every section", () => {
    expect(sectionForBooth(SEATRADE, "99")).toBeNull();
    expect(sectionForBooth(SEATRADE, "9999")).toBeNull();
  });

  it("returns null for show-management work, which has no place on the floor", () => {
    expect(sectionForBooth(SEATRADE, "SM")).toBeNull();
  });

  it("returns null when the show has no sections drawn yet", () => {
    expect(sectionForBooth([], "1585")).toBeNull();
  });
});

describe("overlappingSection", () => {
  it("catches a range that would give a booth two answers", () => {
    expect(overlappingSection(SEATRADE, { boothStart: 600, boothEnd: 800 })?.name).toBe("Section 1");
  });

  it("allows a range that abuts without overlapping", () => {
    expect(overlappingSection(SEATRADE, { boothStart: 2300, boothEnd: 2999 })).toBeNull();
  });

  it("ignores the section being edited when checking itself", () => {
    expect(overlappingSection(SEATRADE, { id: "2", boothStart: 700, boothEnd: 1299 })).toBeNull();
    // Widening it into its neighbour is still caught.
    expect(overlappingSection(SEATRADE, { id: "2", boothStart: 700, boothEnd: 1400 })?.name).toBe("Section 3");
  });
});

describe("describeSection", () => {
  it("reads the way her own labels read", () => {
    expect(describeSection(SEATRADE[1])).toBe("Section 2 (700-1299)");
  });
});
