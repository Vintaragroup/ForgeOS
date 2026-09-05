// Every proposal needs a standard project timeline -- a fixed, always-
// present checklist of milestones (deposit, artwork deadline, install,
// etc.), each with a date and a responsible party, reviewable/editable on
// the Opportunity page and rendered on the Proposal PDF below Project
// Description. See data/Project-Timeline.png for the reference format this
// mirrors.
//
// Four of the eleven canonical milestones have a matching structured
// Opportunity field (shipDate/targetMoveIn/targetMoveOut/eventStartDate) --
// that field wins whenever it's set, but AI extraction (lib/ai/
// timeline-service.ts) is also asked about all 4 as a fallback for when
// it's empty, since the same document that states the other dates often
// states these too (confirmed live: a real client-supplied project
// timeline document did). Two more are computed from a fifth via a fixed
// lead-time rule; the rest need AI extraction or manual estimator entry.
// Pure calculation functions are kept separate from the DB-touching
// orchestration below, same split as estimate-service.ts.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { TimelineMilestoneType, TimelineResponsibleParty } from "@/generated/prisma/enums";
import {
  runTimelineExtraction,
  type AiEligibleMilestoneType,
  type TimelineMilestoneSuggestion,
} from "@/lib/ai/timeline-service";

export type TimelineMilestoneSource = "DETERMINISTIC" | "COMPUTED" | "AI_SUGGESTED" | "MANUAL";

export interface TimelineMilestone {
  type: TimelineMilestoneType;
  label: string;
  date: string | null;
  responsibleParty: TimelineResponsibleParty;
  source: TimelineMilestoneSource;
  // A milestone without a confirmed date is flagged in the review UI and
  // excluded from the PDF -- DETERMINISTIC entries confirm themselves the
  // moment the underlying Opportunity field is set; AI_SUGGESTED/COMPUTED
  // stay unconfirmed until an estimator reviews them; MANUAL is always
  // confirmed (a human just typed it in).
  confirmed: boolean;
  sourceQuote?: string | null;
  documentId?: string | null;
  pageNumber?: number | null;
}

export interface TimelineData {
  generatedAt: string;
  milestones: TimelineMilestone[];
}

// Single source of truth for order/labels/default responsible party --
// both the review UI and the AI prompt (lib/ai/timeline-service.ts) key
// off this list. Defaults follow the reference image's own tags where
// given; the two milestones the image doesn't tag (Production meeting,
// Show open) get a reasonable default -- both are freely editable per row.
export const CANONICAL_MILESTONES: {
  type: TimelineMilestoneType;
  label: string;
  defaultResponsibleParty: TimelineResponsibleParty;
}[] = [
  { type: "SIGNED_PROPOSAL", label: "Signed proposal", defaultResponsibleParty: "CLIENT" },
  { type: "DEPOSIT_DUE", label: "Deposit due", defaultResponsibleParty: "CLIENT" },
  { type: "PRODUCTION_MEETING", label: "Production meeting", defaultResponsibleParty: "EXPO_CC" },
  { type: "ARTWORK_DEADLINE", label: "Production-ready artwork deadline", defaultResponsibleParty: "CLIENT" },
  { type: "ARTWORK_RUSH_50", label: "Artwork deadline before 50% rush fees apply", defaultResponsibleParty: "CLIENT" },
  { type: "ARTWORK_RUSH_100", label: "Artwork deadline before 100% rush fees apply", defaultResponsibleParty: "CLIENT" },
  { type: "BALANCE_DUE", label: "Balance due", defaultResponsibleParty: "CLIENT" },
  { type: "SHIPPING", label: "Shipping to show site", defaultResponsibleParty: "EXPO_CC" },
  { type: "INSTALLATION", label: "Installation", defaultResponsibleParty: "EXPO_CC" },
  { type: "SHOW_OPEN", label: "Show open", defaultResponsibleParty: "CLIENT" },
  { type: "DISMANTLE", label: "Dismantle", defaultResponsibleParty: "EXPO_CC" },
];

// Fixed lead-time rule, confirmed with the user -- matches the reference
// image's 12/7 -> 12/21 -> 12/28 spacing. Rush fees escalate the closer to
// the normal deadline artwork actually arrives; both offsets are measured
// from ARTWORK_DEADLINE itself, independent of install date.
const RUSH_50_OFFSET_DAYS = 14;
const RUSH_100_OFFSET_DAYS = 21;

type OpportunityDateFields = {
  targetMoveIn: Date | null;
  targetMoveOut: Date | null;
  eventStartDate: Date | null;
  shipDate: Date | null;
};

// The 4 canonical types that are just existing structured Opportunity
// fields -- no AI, no ambiguity, always fresh on every regenerate (unless
// an estimator has since MANUALly overridden that row).
const DETERMINISTIC_FIELD_BY_TYPE: Partial<Record<TimelineMilestoneType, keyof OpportunityDateFields>> = {
  INSTALLATION: "targetMoveIn",
  DISMANTLE: "targetMoveOut",
  SHOW_OPEN: "eventStartDate",
  SHIPPING: "shipDate",
};

// Every canonical type EXCEPT the 2 pure rush-fee cutoffs -- what
// lib/ai/timeline-service.ts's extraction pass is asked about on every
// regenerate. The 4 with a matching structured field (see
// DETERMINISTIC_FIELD_BY_TYPE) are included too, as a fallback source:
// regenerateTimeline below only applies the AI suggestion for one of
// those 4 when the structured field itself is still empty.
export const AI_ELIGIBLE_MILESTONE_TYPES: AiEligibleMilestoneType[] = CANONICAL_MILESTONES.map((m) => m.type).filter(
  (t): t is AiEligibleMilestoneType => t !== "ARTWORK_RUSH_50" && t !== "ARTWORK_RUSH_100",
);

function emptyMilestone(type: TimelineMilestoneType): TimelineMilestone {
  const canonical = CANONICAL_MILESTONES.find((m) => m.type === type)!;
  return {
    type,
    label: canonical.label,
    date: null,
    responsibleParty: canonical.defaultResponsibleParty,
    source: "MANUAL",
    confirmed: false,
  };
}

// The full 11-row skeleton, all flagged missing -- what the review UI
// shows before a Timeline has ever been generated/edited, so the checklist
// itself (not just its populated rows) is visible from the start.
export function buildEmptyMilestones(): TimelineMilestone[] {
  return CANONICAL_MILESTONES.map((m) => emptyMilestone(m.type));
}

export function buildDeterministicMilestones(opportunity: OpportunityDateFields): TimelineMilestone[] {
  return CANONICAL_MILESTONES.map(({ type, label, defaultResponsibleParty }) => {
    const field = DETERMINISTIC_FIELD_BY_TYPE[type];
    if (!field) return emptyMilestone(type);
    const date = opportunity[field];
    return {
      type,
      label,
      date: date ? date.toISOString() : null,
      responsibleParty: defaultResponsibleParty,
      source: "DETERMINISTIC",
      confirmed: date !== null,
    };
  });
}

// Fills ARTWORK_RUSH_50/100 from ARTWORK_DEADLINE + the fixed offsets above,
// only when a rush row is still unset -- an existing date (estimator-set or
// otherwise) is never overwritten by the default. Still marked unconfirmed:
// it's a computed guess, not a fact an estimator has reviewed.
export function applyRushFeeDefaults(milestones: TimelineMilestone[]): TimelineMilestone[] {
  const deadline = milestones.find((m) => m.type === "ARTWORK_DEADLINE");
  const deadlineDate = deadline?.date ? new Date(deadline.date) : null;
  if (!deadlineDate) return milestones;

  return milestones.map((m) => {
    if (m.date !== null) return m;
    if (m.type === "ARTWORK_RUSH_50") {
      const date = new Date(deadlineDate);
      date.setDate(date.getDate() + RUSH_50_OFFSET_DAYS);
      return { ...m, date: date.toISOString(), source: "COMPUTED" as const, confirmed: false };
    }
    if (m.type === "ARTWORK_RUSH_100") {
      const date = new Date(deadlineDate);
      date.setDate(date.getDate() + RUSH_100_OFFSET_DAYS);
      return { ...m, date: date.toISOString(), source: "COMPUTED" as const, confirmed: false };
    }
    return m;
  });
}

// Overlays AI-classified suggestions onto the deterministic/empty
// baseline. For one of the 4 types with a matching structured Opportunity
// field (Shipping/Installation/Show open/Dismantle), the AI suggestion is
// only applied when that field's own date is still null -- a real,
// already-confirmed fact on the Opportunity record always outranks a
// document guess. Every other type applies its suggestion unconditionally
// (there's no competing structured field to prefer).
export function applyAiSuggestions(
  milestones: TimelineMilestone[],
  suggestions: TimelineMilestoneSuggestion[],
): TimelineMilestone[] {
  return milestones.map((m) => {
    const suggestion = suggestions.find((s) => s.type === m.type);
    if (!suggestion) return m;
    if (DETERMINISTIC_FIELD_BY_TYPE[m.type] && m.date !== null) return m;
    return {
      ...m,
      date: suggestion.date,
      source: "AI_SUGGESTED" as const,
      confirmed: false,
      sourceQuote: suggestion.sourceQuote,
      documentId: suggestion.documentId,
      pageNumber: suggestion.pageNumber,
    };
  });
}

function parseTimelineData(raw: Prisma.JsonValue | null): TimelineData | null {
  if (!raw) return null;
  return raw as unknown as TimelineData;
}

export function getTimelineData(timelineMilestones: Prisma.JsonValue | null): TimelineData | null {
  return parseTimelineData(timelineMilestones);
}

// Not gated by EstimateVersion.isLocked/Opportunity stage -- this is
// drafting-phase data, same posture as the profitability tab's internal
// costs (never blocked by the client-facing lock).
export async function updateTimelineMilestone(
  opportunityId: string,
  type: TimelineMilestoneType,
  update: { date: Date | null; responsibleParty: TimelineResponsibleParty },
): Promise<TimelineData> {
  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    select: { timelineMilestones: true },
  });

  const current = parseTimelineData(opportunity.timelineMilestones) ?? {
    generatedAt: new Date().toISOString(),
    milestones: buildEmptyMilestones(),
  };

  const milestones = current.milestones.map((m) =>
    m.type === type
      ? {
          ...m,
          date: update.date ? update.date.toISOString() : null,
          responsibleParty: update.responsibleParty,
          source: "MANUAL" as const,
          confirmed: true,
        }
      : m,
  );

  const data: TimelineData = { generatedAt: current.generatedAt, milestones };
  await db.opportunity.update({
    where: { id: opportunityId },
    data: { timelineMilestones: data as unknown as Prisma.InputJsonValue },
  });
  return data;
}

// Orchestrates a full regenerate: deterministic fields refresh from the
// Opportunity's current state, the 5 open milestone types get one AI
// extraction pass, rush-fee defaults fill in where still unset -- but any
// row an estimator has since hand-edited (source MANUAL) is restored
// exactly as they left it, never silently overwritten by a re-run.
export async function regenerateTimeline(opportunityId: string, userId: string | null = null): Promise<TimelineData> {
  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    select: {
      targetMoveIn: true,
      targetMoveOut: true,
      eventStartDate: true,
      shipDate: true,
      timelineMilestones: true,
    },
  });

  const existing = parseTimelineData(opportunity.timelineMilestones);
  const existingByType = new Map(existing?.milestones.map((m) => [m.type, m]) ?? []);

  const deterministic = buildDeterministicMilestones(opportunity);
  const suggestions = await runTimelineExtraction(opportunityId, userId, AI_ELIGIBLE_MILESTONE_TYPES);
  const withAi = applyAiSuggestions(deterministic, suggestions);

  // MANUAL restoration has to happen BEFORE applyRushFeeDefaults, not
  // after -- otherwise a hand-edited ARTWORK_DEADLINE (a MANUAL row) never
  // reaches the rush-fee calculation at all: it would still compute off
  // the freshly-rebuilt (null) deadline above, leaving both rush rows
  // stuck unset even though the estimator already supplied a real
  // deadline. Confirmed live against a real opportunity before this fix.
  // A MANUAL row only really represents a real edit once it has a real
  // date -- a MANUAL row with a null date is indistinguishable from
  // "never resolved yet" (emptyMilestone's own baseline defaults every
  // non-field-backed type to source MANUAL, date null, before anything
  // has ever tried to classify it). Requiring a real date here is what
  // makes those types re-attemptable on every regenerate; without it,
  // confirmed live against a real opportunity: 7 of 11 milestones got
  // written once with source MANUAL/date null on an early regenerate (from
  // before label matching or the DRAWING fallback existed) and were then
  // permanently frozen at Missing forever after, since every later
  // regenerate saw "MANUAL" and restored that exact stale null value
  // instead of ever giving the improved matching logic a chance to run.
  const withManualRestored = withAi.map((m) => {
    const existingEntry = existingByType.get(m.type);
    return existingEntry?.source === "MANUAL" && existingEntry.date !== null ? existingEntry : m;
  });

  const milestones = applyRushFeeDefaults(withManualRestored);

  const data: TimelineData = { generatedAt: new Date().toISOString(), milestones };
  await db.opportunity.update({
    where: { id: opportunityId },
    data: { timelineMilestones: data as unknown as Prisma.InputJsonValue },
  });
  return data;
}
