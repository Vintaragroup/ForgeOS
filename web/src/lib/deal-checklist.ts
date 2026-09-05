// Derives a short, stage-aware "what's next" list for an Opportunity
// entirely from data that already exists elsewhere in the app (documents,
// estimates, proposals, key dates) -- no new schema, no caching, no
// AI call. Computed fresh on every page render the same way
// getFieldSuggestions/getFieldSuggestions-style helpers already do, so it
// can never go stale the way a stored/cached checklist could.
//
// A pure function, not a query -- callers (opportunities/[id]/page.tsx)
// gather the inputs from data they're already fetching for other cards on
// the page, so this adds zero new database round trips.

export interface DealChecklistItem {
  id: string;
  label: string;
  href: string;
  urgent: boolean;
}

export interface DealChecklistInput {
  opportunityId: string;
  stage: string;
  primaryContactId: string | null;
  ownerId: string | null;
  pendingFieldSuggestionCount: number;
  // Count of real, actionable documents (excludes PRICING_SCHEDULE, which
  // never goes through Analyze) still PENDING or FAILED -- see
  // ExtractionStatusChip in opportunities/[id]/page.tsx for the same
  // status vocabulary.
  documentsNeedingAnalysisCount: number;
  hasScopeDocuments: boolean;
  recommendedClarificationQuestionCount: number;
  bidderQuestionsDeadlineLabel: string | null;
  // Count of the 11 canonical Timeline milestones (timeline-service.ts)
  // still missing a date -- includes a Timeline that's never been
  // generated at all (11/11 missing), same "counts as missing until
  // resolved" posture as everything else on this checklist.
  missingTimelineMilestoneCount: number;
  estimateId: string | null;
  currentVersion: { isLocked: boolean; isApproved: boolean } | null;
  // Proposals for the CURRENT estimate version only -- an older version's
  // proposal history isn't relevant to "what does this deal need next."
  currentVersionProposals: { sentAt: Date | null; signedAt: Date | null }[];
  projectCount: number;
  now?: Date;
}

const FOLLOW_UP_AFTER_DAYS = 7;

// User-set thresholds for the "time in stage" badge (opportunities/[id]/
// page.tsx's stage-age indicator, next to the stage chip): 10 days is a
// mild "keep an eye on this," 14 is the point it's genuinely stalled.
export const STAGE_AGE_WARNING_DAYS = 10;
export const STAGE_AGE_CRITICAL_DAYS = 14;

function daysSince(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

// Only meaningful for a deal still in play -- WON/LOST are terminal, so
// "stuck in stage" doesn't apply to them the same way (see
// buildDealChecklist's own early return for those stages).
export function daysInStage(stageChangedAt: Date, now: Date = new Date()): number {
  return daysSince(stageChangedAt, now);
}

export function buildDealChecklist(input: DealChecklistInput): DealChecklistItem[] {
  const now = input.now ?? new Date();
  const detailsHref = `/opportunities/${input.opportunityId}?editDetails=1#details`;

  // A closed deal has a different job: WON means "get it into production,"
  // LOST means there's nothing left to action here at all.
  if (input.stage === "LOST") return [];
  if (input.stage === "WON") {
    if (input.projectCount > 0) return [];
    return [
      {
        id: "convert-to-project",
        label: "Convert this won deal to a Project to start production.",
        href: `/opportunities/${input.opportunityId}#project`,
        urgent: false,
      },
    ];
  }

  const items: DealChecklistItem[] = [];

  if (!input.primaryContactId) {
    items.push({ id: "primary-contact", label: "Add a primary contact.", href: detailsHref, urgent: false });
  }
  if (!input.ownerId) {
    items.push({ id: "owner", label: "Assign an owner so this deal has a clear driver.", href: detailsHref, urgent: false });
  }
  if (input.pendingFieldSuggestionCount > 0) {
    items.push({
      id: "field-suggestions",
      label: `Review ${input.pendingFieldSuggestionCount} field${input.pendingFieldSuggestionCount === 1 ? "" : "s"} suggested from documents.`,
      href: detailsHref,
      urgent: false,
    });
  }
  if (input.documentsNeedingAnalysisCount > 0) {
    items.push({
      id: "analyze-documents",
      label: `Analyze ${input.documentsNeedingAnalysisCount} uploaded document${input.documentsNeedingAnalysisCount === 1 ? "" : "s"}.`,
      href: `/opportunities/${input.opportunityId}#documents`,
      urgent: false,
    });
  }
  if (input.hasScopeDocuments && input.recommendedClarificationQuestionCount > 0) {
    items.push({
      id: "clarification-questions",
      label:
        `Review ${input.recommendedClarificationQuestionCount} recommended clarification question` +
        `${input.recommendedClarificationQuestionCount === 1 ? "" : "s"} to send the client` +
        (input.bidderQuestionsDeadlineLabel ? ` (bidder questions due ${input.bidderQuestionsDeadlineLabel}).` : "."),
      href: `/opportunities/${input.opportunityId}#clarification-questions`,
      urgent: Boolean(input.bidderQuestionsDeadlineLabel),
    });
  }

  if (input.missingTimelineMilestoneCount > 0) {
    // Non-urgent while the deal is still early -- there's real time left
    // to fill these in. Becomes urgent once the estimate is locked+
    // approved, the same point "generate-proposal"/"send-proposal" would
    // otherwise appear below: this is exactly the moment "every proposal
    // needs this timeline" stops being a someday task and starts blocking
    // a client-ready document from actually being complete.
    items.push({
      id: "timeline-incomplete",
      label:
        `Fill in ${input.missingTimelineMilestoneCount} missing Timeline milestone` +
        `${input.missingTimelineMilestoneCount === 1 ? "" : "s"} before the proposal goes out.`,
      href: `/opportunities/${input.opportunityId}#timeline`,
      urgent: Boolean(input.currentVersion?.isLocked && input.currentVersion?.isApproved),
    });
  }

  if (!input.estimateId) {
    items.push({
      id: "start-estimate",
      label: "Start an estimate.",
      href: `/opportunities/${input.opportunityId}#estimates`,
      urgent: false,
    });
  } else if (!input.currentVersion) {
    // Estimate exists with no current version yet -- an edge case
    // (versions are created alongside the estimate itself) rather than a
    // real user-facing state, so no checklist item needed here.
  } else if (!(input.currentVersion.isLocked && input.currentVersion.isApproved)) {
    items.push({
      id: "finalize-estimate",
      label: "Lock and approve the estimate before it can become a proposal.",
      href: `/estimates/${input.estimateId}`,
      urgent: false,
    });
  } else {
    const latestProposal = input.currentVersionProposals[0] ?? null;
    if (!latestProposal) {
      items.push({
        id: "generate-proposal",
        label: "Generate a proposal from the approved estimate.",
        href: `/estimates/${input.estimateId}`,
        urgent: false,
      });
    } else if (!latestProposal.sentAt) {
      items.push({
        id: "send-proposal",
        label: "Send the generated proposal to the client.",
        href: `/estimates/${input.estimateId}`,
        urgent: false,
      });
    } else if (!latestProposal.signedAt) {
      const days = daysSince(latestProposal.sentAt, now);
      if (days >= FOLLOW_UP_AFTER_DAYS) {
        items.push({
          id: "follow-up-proposal",
          label: `Follow up -- the proposal was sent ${days} days ago with no signature yet.`,
          href: `/estimates/${input.estimateId}`,
          urgent: true,
        });
      }
    }
  }

  return items;
}
