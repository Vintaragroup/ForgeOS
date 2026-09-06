import { describe, expect, it } from "vitest";
import { formatOpportunityLabel } from "@/lib/opportunity-name";

describe("formatOpportunityLabel", () => {
  it("composes the full convention when every piece is known", () => {
    expect(
      formatOpportunityLabel({
        companyName: "Acme Corp",
        showName: "PGA Orlando",
        eventStartDate: "2027-01-15",
        boothNumber: "412",
      }),
    ).toBe("Acme Corp @ PGA Orlando 2027 – Booth 412");
  });

  it("omits the booth segment when unknown, per the estimator's own '(if known)' wording", () => {
    expect(
      formatOpportunityLabel({
        companyName: "Acme Corp",
        showName: "PGA Orlando",
        eventStartDate: "2027-01-15",
        boothNumber: null,
      }),
    ).toBe("Acme Corp @ PGA Orlando 2027");
  });

  it("omits the year when the event date isn't set yet -- routine at the earliest opportunity stage", () => {
    expect(
      formatOpportunityLabel({
        companyName: "Acme Corp",
        showName: "PGA Orlando",
        eventStartDate: null,
        boothNumber: "412",
      }),
    ).toBe("Acme Corp @ PGA Orlando – Booth 412");
  });

  it("reads the year in UTC, not local time -- an early-January show shouldn't roll back a year west of UTC", () => {
    expect(
      formatOpportunityLabel({
        companyName: "Acme Corp",
        showName: "CES",
        eventStartDate: "2027-01-01",
        boothNumber: null,
      }),
    ).toBe("Acme Corp @ CES 2027");
  });

  it("returns empty until both the required pieces (company, show) are known", () => {
    expect(
      formatOpportunityLabel({ companyName: "", showName: "PGA Orlando", eventStartDate: null, boothNumber: null }),
    ).toBe("");
    expect(
      formatOpportunityLabel({ companyName: "Acme Corp", showName: "  ", eventStartDate: null, boothNumber: null }),
    ).toBe("");
  });

  it("trims incidental whitespace from free-text inputs", () => {
    expect(
      formatOpportunityLabel({
        companyName: "  Acme Corp  ",
        showName: "  PGA Orlando  ",
        eventStartDate: null,
        boothNumber: "  412  ",
      }),
    ).toBe("Acme Corp @ PGA Orlando – Booth 412");
  });
});
