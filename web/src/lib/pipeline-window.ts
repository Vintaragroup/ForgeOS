// How long a closed deal stays on the pipeline board.
//
// Won and Lost are permanent states with no exit, so with no window they
// accumulate forever. On the day this was written all 47 deals in Won were
// PGA Show exhibitors imported from the 2026 graphics control log -- work
// delivered in January and never sold through ForgeOS at all -- sitting
// beside a live funnel of nine.
//
// A leaf module: pure date rules, no db import.

// Six months.
export const CLOSED_WINDOW_DAYS = 183;

// Open stages are deliberately never windowed. An old deal still sitting
// in Estimating is exactly what someone needs to see -- that is what the
// "Nd in stage" warning exists for -- so ageing it off would hide the
// problem rather than the history.
const TERMINAL_STAGES: ReadonlySet<string> = new Set(["WON", "LOST"]);

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

export interface ClosedOnInput {
  // The deal's own event date, when someone set one.
  eventStartDate: Date | null;
  // The show it belongs to, which carries the date for anything imported.
  show: { eventStartDate: Date | null } | null;
  // Latest stage transition, falling back to the row's creation.
  lastStageChange: Date;
}

// When the work a deal represents actually happened -- which is NOT the
// same as when its row appeared.
//
// The PGA deals were written straight into the database by the import,
// with no stage event, so their "last stage change" is really the date of
// the import, weeks ago. Ageing off that would have hidden nothing at all.
// The show's own date is the honest answer: PGA Show 2026 ran in January.
export function pipelineClosedOn(opp: ClosedOnInput): Date {
  return opp.eventStartDate ?? opp.show?.eventStartDate ?? opp.lastStageChange;
}

// A deal won for a show that has not happened yet dates to the future and
// so always stays on the board -- it is won work still to deliver, not
// history.
export function agedOffPipeline(stage: string, closedOn: Date, now: Date = new Date()): boolean {
  if (!TERMINAL_STAGES.has(stage)) return false;
  return daysBetween(now, closedOn) > CLOSED_WINDOW_DAYS;
}
