import { describe, expect, it } from "vitest";
import {
  ARTWORK_ORDER_TYPES,
  ARTWORK_ORDER_TYPE_LABELS,
  isAutoApproved,
  orderTypeFromTrackerCode,
  requiresReprintReason,
} from "@/lib/artwork-order-type";

describe("orderTypeFromTrackerCode", () => {
  it("reads the three values her SM or EXH column actually holds", () => {
    // Seatrade April 2026: SM 107, EXH 96, Site 79.
    expect(orderTypeFromTrackerCode("EXH")).toBe("EXHIBITOR");
    expect(orderTypeFromTrackerCode("SM")).toBe("SHOW_MANAGEMENT");
    expect(orderTypeFromTrackerCode("Site")).toBe("SITE");
  });

  it("is case-insensitive and trims, since the export is hand-typed", () => {
    // The Booth column in the same export holds both "SM" and "sm".
    expect(orderTypeFromTrackerCode("  site ")).toBe("SITE");
    expect(orderTypeFromTrackerCode("sm")).toBe("SHOW_MANAGEMENT");
  });

  it("returns null for anything it doesn't recognise rather than guessing", () => {
    expect(orderTypeFromTrackerCode("")).toBeNull();
    expect(orderTypeFromTrackerCode(null)).toBeNull();
    expect(orderTypeFromTrackerCode("Something else")).toBeNull();
  });
});

describe("the rules that hang off order type", () => {
  it("auto-approves site work only", () => {
    expect(isAutoApproved("SITE")).toBe(true);
    expect(isAutoApproved("EXHIBITOR")).toBe(false);
    expect(isAutoApproved("SHOW_MANAGEMENT")).toBe(false);
    // Unknown type must not inherit a site rule.
    expect(isAutoApproved(null)).toBe(false);
  });

  it("requires a reprint reason on site prints only", () => {
    expect(requiresReprintReason("SITE")).toBe(true);
    expect(requiresReprintReason("EXHIBITOR")).toBe(false);
    expect(requiresReprintReason(null)).toBe(false);
  });
});

describe("labels", () => {
  it("names every type, so a picker can't render a blank option", () => {
    for (const t of ARTWORK_ORDER_TYPES) {
      expect(ARTWORK_ORDER_TYPE_LABELS[t]).toBeTruthy();
    }
    expect(Object.keys(ARTWORK_ORDER_TYPE_LABELS).sort()).toEqual([...ARTWORK_ORDER_TYPES].sort());
  });
});
