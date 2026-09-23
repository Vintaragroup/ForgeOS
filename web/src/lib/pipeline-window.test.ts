import { describe, expect, it } from "vitest";
import { agedOffPipeline, pipelineClosedOn } from "@/lib/pipeline-window";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function monthsAgo(n: number): Date {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - n);
  return d;
}
function monthsAhead(n: number): Date {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() + n);
  return d;
}

describe("pipelineClosedOn", () => {
  it("prefers the deal's own event date", () => {
    const when = pipelineClosedOn({
      eventStartDate: monthsAgo(2),
      show: { eventStartDate: monthsAgo(9) },
      lastStageChange: NOW,
    });
    expect(when).toEqual(monthsAgo(2));
  });

  it("falls back to the show's date for an imported deal", () => {
    // The PGA rows were written straight into the database with no stage
    // event, so their lastStageChange is the date of the IMPORT -- recent.
    // Dating them by that would have aged nothing off the board.
    const when = pipelineClosedOn({
      eventStartDate: null,
      show: { eventStartDate: new Date("2026-01-20T00:00:00.000Z") },
      lastStageChange: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(when.toISOString()).toBe("2026-01-20T00:00:00.000Z");
  });

  it("falls back to the stage change when there is no show at all", () => {
    const when = pipelineClosedOn({ eventStartDate: null, show: null, lastStageChange: monthsAgo(1) });
    expect(when).toEqual(monthsAgo(1));
  });
});

describe("agedOffPipeline", () => {
  it("keeps an open deal however old it is", () => {
    // An old deal still in Estimating is the thing you most need to see.
    for (const stage of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATING"]) {
      expect(agedOffPipeline(stage, monthsAgo(24), NOW), stage).toBe(false);
    }
  });

  it("ages off a deal closed more than six months ago", () => {
    expect(agedOffPipeline("WON", monthsAgo(8), NOW)).toBe(true);
    expect(agedOffPipeline("LOST", monthsAgo(8), NOW)).toBe(true);
  });

  it("keeps a recently closed deal", () => {
    expect(agedOffPipeline("WON", monthsAgo(2), NOW)).toBe(false);
  });

  it("keeps work won for a show that hasn't happened yet", () => {
    // Won and still to deliver is not history.
    expect(agedOffPipeline("WON", monthsAhead(7), NOW)).toBe(false);
  });

  it("ages off the PGA import specifically", () => {
    // The case that prompted this: PGA Show 2026 ran in January, the rows
    // were imported months later, and all 47 sat in Won indefinitely.
    const closedOn = pipelineClosedOn({
      eventStartDate: null,
      show: { eventStartDate: new Date("2026-01-20T00:00:00.000Z") },
      lastStageChange: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(agedOffPipeline("WON", closedOn, NOW)).toBe(true);
  });
});
