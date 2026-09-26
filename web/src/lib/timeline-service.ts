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
  // Only ever set for one of the 4 structured-field-backed types
  // (Shipping/Installation/Show open/Dismantle) when that field is set
  // (so it wins as `date` above) AND a scope document states a genuinely
  // different date for the same milestone -- surfaced so a stale onboarding
  // field doesn't silently disagree with the document unnoticed. Confirmed
  // real: a live opportunity's Show Open field read Jan 3 while its own
  // source document said Jan 7, and nothing on the page said so before this.
  conflict?: { date: string; sourceQuote: string; documentId: string; pageNumber: number | null } | null;
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

// The estimating workbook's own arithmetic, lifted verbatim from
// PROPOSAL!A14:A24 of the Orlando estimate template.
//
//   A15 deposit          = A14 + 5        A17 artwork ready = A18 - 14
//   A16 production mtg   = A14 + 7        A18 50% rush      = A19 - 7
//                                         A19 100% rush     = A21 - 7
//                                         A20 balance due   = A21 - 5
//
// Collapsed, the back-chain is four offsets from the ship date and two
// forward from the signed-proposal date. Both are written that way here
// so one anchor moving cannot leave the four deadlines disagreeing with
// each other -- which is what a chain of relative offsets risks.
//
// The two rush cutoffs used to be measured forward from ARTWORK_DEADLINE
// (+14/+21). Same dates, since the deadline is itself ship - 28, but two
// anchors for one set of rules; re-anchored to ship so there is one.
//
// Plain calendar days, no weekend or holiday shifting -- the workbook does
// not do it and this is meant to reproduce the workbook, not improve on it.
const DEPOSIT_AFTER_SIGNING_DAYS = 5;
const PRODUCTION_MEETING_AFTER_SIGNING_DAYS = 7;
const ARTWORK_BEFORE_SHIP_DAYS = 28;
const RUSH_50_BEFORE_SHIP_DAYS = 14;
const RUSH_100_BEFORE_SHIP_DAYS = 7;
const BALANCE_BEFORE_SHIP_DAYS = 5;

export type OpportunityDateFields = {
  targetMoveIn: Date | null;
  targetMoveOut: Date | null;
  eventStartDate: Date | null;
  shipDate: Date | null;
  signedProposalTargetDate?: Date | null;
};

// Which anchor each computed milestone hangs off, and by how many days.
// Negative counts back from the ship date, positive forward from signing.
const DERIVED_RULES: {
  type: TimelineMilestoneType;
  anchor: "shipDate" | "signedProposalTargetDate";
  offsetDays: number;
}[] = [
  { type: "DEPOSIT_DUE", anchor: "signedProposalTargetDate", offsetDays: DEPOSIT_AFTER_SIGNING_DAYS },
  { type: "PRODUCTION_MEETING", anchor: "signedProposalTargetDate", offsetDays: PRODUCTION_MEETING_AFTER_SIGNING_DAYS },
  { type: "ARTWORK_DEADLINE", anchor: "shipDate", offsetDays: -ARTWORK_BEFORE_SHIP_DAYS },
  { type: "ARTWORK_RUSH_50", anchor: "shipDate", offsetDays: -RUSH_50_BEFORE_SHIP_DAYS },
  { type: "ARTWORK_RUSH_100", anchor: "shipDate", offsetDays: -RUSH_100_BEFORE_SHIP_DAYS },
  { type: "BALANCE_DUE", anchor: "shipDate", offsetDays: -BALANCE_BEFORE_SHIP_DAYS },
];

// What a milestone is waiting on, when its anchor has not been entered.
// Said out loud on the opportunity page instead of showing a date nobody
// chose -- a guessed deadline is worse than a visibly missing one when
// rush charges hang off it.
export const ANCHOR_LABEL: Record<"shipDate" | "signedProposalTargetDate", string> = {
  shipDate: "shipping date",
  signedProposalTargetDate: "signed-proposal deadline",
};

export function describeDerivedRule(type: TimelineMilestoneType): string | null {
  const rule = DERIVED_RULES.find((r) => r.type === type);
  if (!rule) return null;
  const days = Math.abs(rule.offsetDays);
  return rule.offsetDays < 0
    ? `${days} days before ${ANCHOR_LABEL[rule.anchor]}`
    : `${days} days after ${ANCHOR_LABEL[rule.anchor]}`;
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

// The 4 canonical types that are just existing structured Opportunity
// fields -- no AI, no ambiguity, always fresh on every regenerate (unless
// an estimator has since MANUALly overridden that row).
const DETERMINISTIC_FIELD_BY_TYPE: Partial<Record<TimelineMilestoneType, keyof OpportunityDateFields>> = {
  INSTALLATION: "targetMoveIn",
  DISMANTLE: "targetMoveOut",
  SHOW_OPEN: "eventStartDate",
  SHIPPING: "shipDate",
  // Entered like the four above, not observed: the deadline the client is
  // given so rush charges do not apply.
  SIGNED_PROPOSAL: "signedProposalTargetDate",
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
    if (field) {
      const date = opportunity[field] ?? null;
      return {
        type,
        label,
        date: date ? date.toISOString() : null,
        responsibleParty: defaultResponsibleParty,
        source: "DETERMINISTIC",
        confirmed: date !== null,
      };
    }

    // Computed from an anchor rather than entered -- the workbook's own
    // arithmetic. Left blank when its anchor is, so the page can say which
    // date it is waiting on instead of showing one nobody chose.
    const rule = DERIVED_RULES.find((r) => r.type === type);
    const anchorDate = rule ? (opportunity[rule.anchor] ?? null) : null;
    if (!rule || !anchorDate) return emptyMilestone(type);
    return {
      type,
      label,
      date: shiftDays(anchorDate, rule.offsetDays).toISOString(),
      responsibleParty: defaultResponsibleParty,
      source: "COMPUTED",
      // Arithmetic off a date somebody entered, not a fact anybody has
      // reviewed -- an estimator still confirms the row.
      confirmed: false,
    };
  });
}

// An opportunity's own date, falling back to its show's.
//
// Shipping, installation, show open and dismantle are dictated by the
// show: every exhibitor at one show works to the same exhibitor kit. So
// they are entered once on the Show and inherited here, and a booth that
// genuinely differs overrides its own field.
export function resolveAnchorDates(
  opportunity: OpportunityDateFields,
  show: Pick<OpportunityDateFields, "targetMoveIn" | "targetMoveOut" | "eventStartDate" | "shipDate"> | null,
): OpportunityDateFields {
  if (!show) return opportunity;
  return {
    ...opportunity,
    targetMoveIn: opportunity.targetMoveIn ?? show.targetMoveIn,
    targetMoveOut: opportunity.targetMoveOut ?? show.targetMoveOut,
    eventStartDate: opportunity.eventStartDate ?? show.eventStartDate,
    shipDate: opportunity.shipDate ?? show.shipDate,
  };
}

// applyRushFeeDefaults used to live here, filling the two rush rows
// forward from ARTWORK_DEADLINE (+14/+21). They now come off the ship date
// with every other deadline -- same dates, one anchor instead of two. See
// DERIVED_RULES.

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
    if (DETERMINISTIC_FIELD_BY_TYPE[m.type] && m.date !== null) {
      // The structured field still wins as the row's actual date -- but a
      // document stating a genuinely different date is a real signal worth
      // surfacing, not silently dropping. Same-date agreement clears any
      // conflict a previous regenerate might have flagged.
      return {
        ...m,
        conflict:
          suggestion.date !== m.date
            ? {
                date: suggestion.date,
                sourceQuote: suggestion.sourceQuote,
                documentId: suggestion.documentId,
                pageNumber: suggestion.pageNumber,
              }
            : null,
      };
    }
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

export interface WorkOrderTimelinePrefill {
  depositDueDate: Date | null;
  productionMeetingDate: Date | null;
  artworkDeadlineDate: Date | null;
  balanceDueDate: Date | null;
  installDate: Date | null;
}

// The WorkOrder production dates that previously had no honest source to
// prefill from (see project-service.ts's startWorkOrder) now inherit from
// the matching Timeline milestone. Any non-null date is used regardless of
// `confirmed` -- an AI_SUGGESTED milestone the estimator hasn't explicitly
// reviewed yet is still a real document-sourced value, strictly better
// than the null these fields started with, and stays directly editable
// afterward on the Work Order card either way -- the same posture the
// installDate document-scan fallback already has (it has no "confirmed"
// concept at all). Requiring confirmed:true here would just relocate the
// "field silently sits blank" problem onto a different page.
export function getWorkOrderPrefillFromTimeline(timelineData: TimelineData | null): WorkOrderTimelinePrefill {
  const dateFor = (type: TimelineMilestoneType): Date | null => {
    const milestone = timelineData?.milestones.find((m) => m.type === type);
    return milestone?.date ? new Date(milestone.date) : null;
  };
  return {
    depositDueDate: dateFor("DEPOSIT_DUE"),
    productionMeetingDate: dateFor("PRODUCTION_MEETING"),
    artworkDeadlineDate: dateFor("ARTWORK_DEADLINE"),
    balanceDueDate: dateFor("BALANCE_DUE"),
    installDate: dateFor("INSTALLATION"),
  };
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
          // An estimator directly setting this row's value has already
          // resolved whatever the flag was pointing at -- carrying a stale
          // conflict forward here would keep flagging a decision that's
          // already been made.
          conflict: null,
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
      signedProposalTargetDate: true,
      timelineMilestones: true,
      // Logistics dates fall back to the show's -- see resolveAnchorDates.
      show: { select: { shipDate: true, targetMoveIn: true, targetMoveOut: true, eventStartDate: true } },
    },
  });

  const existing = parseTimelineData(opportunity.timelineMilestones);
  const existingByType = new Map(existing?.milestones.map((m) => [m.type, m]) ?? []);

  const deterministic = buildDeterministicMilestones(resolveAnchorDates(opportunity, opportunity.show));
  const suggestions = await runTimelineExtraction(opportunityId, userId, AI_ELIGIBLE_MILESTONE_TYPES);
  const withAi = applyAiSuggestions(deterministic, suggestions);

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
  //
  // The rush-fee pass that used to run after this is gone: both rush rows
  // are computed from the ship date in buildDeterministicMilestones, so
  // there is no longer an ordering hazard between a hand-edited artwork
  // deadline and the rows derived from it.
  const milestones = withAi.map((m) => {
    const existingEntry = existingByType.get(m.type);
    return existingEntry?.source === "MANUAL" && existingEntry.date !== null ? existingEntry : m;
  });

  const data: TimelineData = { generatedAt: new Date().toISOString(), milestones };
  await db.opportunity.update({
    where: { id: opportunityId },
    data: { timelineMilestones: data as unknown as Prisma.InputJsonValue },
  });
  return data;
}
