import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  approvalDeadlineFor,
  businessDaysBetween,
  classifyMaterial,
  productionStartFor,
  slaStatus,
  TURNAROUND_BUSINESS_DAYS,
} from "@/lib/graphics-sla";

// 2026-09-21 is a Monday.
const MON = new Date("2026-09-21T12:00:00Z");

describe("classifyMaterial", () => {
  it("reads her material vocabulary as the data actually spells it", () => {
    expect(classifyMaterial("Fabric (Black-Back)")).toBe("FABRIC");
    expect(classifyMaterial("Fabric (Lightbox)")).toBe("FABRIC");
    expect(classifyMaterial('PVC (White) - 1/8"')).toBe("RIGID");
    expect(classifyMaterial("Vinyl (RTA)")).toBe("RIGID");
    expect(classifyMaterial('1" Ultraboard - White')).toBe("RIGID");
    expect(classifyMaterial("Foamboard - 3/16\"")).toBe("RIGID");
  });

  it("treats SEG as fabric, since that is what it is", () => {
    expect(classifyMaterial("SEG")).toBe("FABRIC");
  });

  it("identifies a hanging sign by the piece, not the material", () => {
    expect(classifyMaterial('PVC (White) - 1/8"', "Hanging Sign")).toBe("HANGING_SIGN");
  });

  it("falls back to rigid rather than throwing on an unknown material", () => {
    expect(classifyMaterial(null)).toBe("RIGID");
    expect(classifyMaterial("Something new")).toBe("RIGID");
  });
});

describe("addBusinessDays", () => {
  it("skips the weekend going forward", () => {
    // Mon + 5 business days = the following Monday.
    expect(addBusinessDays(MON, 5).toISOString().slice(0, 10)).toBe("2026-09-28");
  });

  it("skips the weekend going backward", () => {
    expect(addBusinessDays(MON, -1).toISOString().slice(0, 10)).toBe("2026-09-18"); // the Friday
  });

  it("returns the same day for zero", () => {
    expect(addBusinessDays(MON, 0).toISOString()).toBe(MON.toISOString());
  });
});

describe("businessDaysBetween", () => {
  it("counts only weekdays", () => {
    expect(businessDaysBetween(MON, new Date("2026-09-28T12:00:00Z"))).toBe(5);
  });

  it("is negative when the target has passed", () => {
    expect(businessDaysBetween(MON, new Date("2026-09-18T12:00:00Z"))).toBe(-1);
  });
});

describe("the SOP's turnaround table", () => {
  it("matches what the SOP states", () => {
    expect(TURNAROUND_BUSINESS_DAYS).toEqual({ FABRIC: 5, HANGING_SIGN: 10, RIGID: 5 });
  });

  it("starts a hanging sign twice as early as a fabric", () => {
    const inHand = new Date("2026-10-19T12:00:00Z"); // a Monday
    expect(productionStartFor(inHand, "FABRIC").toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(productionStartFor(inHand, "HANGING_SIGN").toISOString().slice(0, 10)).toBe("2026-10-05");
  });

  it("puts the approval deadline 10 business days before the show", () => {
    // PGA Show 2027 opens Tuesday 26 January 2027.
    expect(approvalDeadlineFor(new Date("2027-01-26T00:00:00Z")).toISOString().slice(0, 10)).toBe("2027-01-12");
  });
});

describe("slaStatus", () => {
  it("says nothing about a piece with no in-hand date rather than guessing", () => {
    expect(slaStatus({ inHandDate: null, material: "Fabric (Black-Back)" }, MON)).toBeNull();
  });

  it("flags rush-fee risk when there is less time left than the turnaround needs", () => {
    // Fabric needs 5 business days; this one has 3.
    const status = slaStatus({ inHandDate: new Date("2026-09-24T12:00:00Z"), material: "Fabric (Black-Back)" }, MON);
    expect(status).toMatchObject({ materialClass: "FABRIC", turnaroundDays: 5, businessDaysRemaining: 3, atRiskOfRushFee: true, overdue: false });
  });

  it("does not flag a piece with enough runway", () => {
    const status = slaStatus({ inHandDate: new Date("2026-10-05T12:00:00Z"), material: "Fabric (Black-Back)" }, MON);
    expect(status?.atRiskOfRushFee).toBe(false);
    expect(status?.overdue).toBe(false);
  });

  it("reports overdue separately from at-risk", () => {
    const status = slaStatus({ inHandDate: new Date("2026-09-17T12:00:00Z"), material: 'PVC (White) - 1/8"' }, MON);
    expect(status?.overdue).toBe(true);
    expect(status?.atRiskOfRushFee).toBe(false);
    expect(status!.businessDaysRemaining).toBeLessThan(0);
  });

  it("gives a hanging sign its longer runway", () => {
    // 7 business days out: fine for fabric, too tight for a hanging sign.
    const inHand = new Date("2026-09-30T12:00:00Z");
    expect(slaStatus({ inHandDate: inHand, material: "Fabric (Black-Back)" }, MON)?.atRiskOfRushFee).toBe(false);
    expect(slaStatus({ inHandDate: inHand, material: "Fabric (Black-Back)", graphicCode: "Hanging Sign" }, MON)?.atRiskOfRushFee).toBe(true);
  });
});
