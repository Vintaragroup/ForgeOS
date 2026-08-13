// Framework-agnostic business logic, kept separate from
// app/opportunities/actions.ts (which only adds the Next.js-specific
// concerns: revalidatePath, redirect). Server Actions call redirect()
// unconditionally, which throws outside a real request context -- pulling
// the actual logic out here is what makes it testable at all.

import { db } from "@/lib/db";
import { OpportunityStage, type CloseReason } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { createEstimateVersion } from "@/lib/estimate-service";
import type { ExtractableOpportunityField } from "@/lib/ai/document-summary-service";
import { parseFreeTextDate } from "@/lib/citation";

export async function changeOpportunityStage(
  id: string,
  toStage: OpportunityStage,
  note: string | null,
  closeReason: CloseReason | null = null,
  closeReasonDetail: string | null = null,
) {
  const current = await db.opportunity.findUniqueOrThrow({ where: { id } });

  // closeReason only ever means something at the moment a deal actually
  // closes -- a value passed in for any other target stage is ignored,
  // and moving AWAY from WON/LOST back into an active stage (reopening a
  // deal) clears whatever reason was recorded, since it would otherwise
  // sit there describing an outcome that's no longer true.
  const isClosing = toStage === "WON" || toStage === "LOST";

  const [updated] = await db.$transaction([
    db.opportunity.update({
      where: { id },
      data: {
        stage: toStage,
        closeReason: isClosing ? closeReason : null,
        closeReasonDetail: isClosing ? closeReasonDetail : null,
      },
    }),
    db.stageChangeEvent.create({
      data: { opportunityId: id, fromStage: current.stage, toStage, note },
    }),
  ]);

  return updated;
}

export async function convertOpportunityToEstimate(opportunityId: string, name: string | null = null) {
  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
  });

  const [estimate] = await db.$transaction([
    // Inherits the opportunity's tax jurisdiction (itself possibly
    // inherited from the company) as a starting default -- the estimate
    // detail page's own "Tax jurisdiction" picker can still override it.
    // name is null for the common single-estimate case (nothing to
    // distinguish it from) -- only meaningful once an Opportunity has
    // multiple Estimates, see Estimate.name's own schema comment.
    db.estimate.create({ data: { opportunityId, taxRateId: opportunity.taxRateId, name } }),
    db.opportunity.update({
      where: { id: opportunityId },
      data: { stage: "ESTIMATING" },
    }),
    db.stageChangeEvent.create({
      data: {
        opportunityId,
        fromStage: opportunity.stage,
        toStage: "ESTIMATING",
        note: "Auto-advanced: estimate created",
      },
    }),
  ]);

  return estimate;
}

// Powers the Opportunity page's "Build estimate from documents" button --
// the guided path from an uploaded pricing schedule to the import
// preview, skipping the manual create-estimate-then-find-the-import-card
// detour. Reuses the opportunity's existing estimate/version if one is
// already there and still open for edits, rather than creating a
// redundant one every time someone clicks it.
export async function getOrCreateEstimateForOpportunity(opportunityId: string) {
  const existing = await db.estimate.findFirst({
    where: { opportunityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { versions: { where: { isCurrent: true }, take: 1 } },
  });

  if (existing) {
    const currentVersion = existing.versions[0];
    if (currentVersion && !currentVersion.isLocked) {
      return { estimateId: existing.id, versionId: currentVersion.id };
    }
    const version = await createEstimateVersion(existing.id, 0);
    return { estimateId: existing.id, versionId: version.id };
  }

  const estimate = await convertOpportunityToEstimate(opportunityId);
  const version = await createEstimateVersion(estimate.id, 0);
  return { estimateId: estimate.id, versionId: version.id };
}

// Auto-fills onboarding fields (boothNumber, boothSize, shipDate,
// eventStartDate, eventEndDate, siteAddress) straight from a freshly
// analyzed document -- called by analyze-document.ts right after a
// document's extractedFields are produced, so a brand-new opportunity
// gets these filled in without a manual "Accept" click per field. Only
// ever fills a field that is currently empty; never overwrites a value
// already there, whether entered by hand or accepted from an earlier
// suggestion -- this can't clobber a real edit. A field that's already
// set and conflicts with what a later document says still surfaces via
// the Opportunity page's own getFieldSuggestions for a human to review,
// same mechanism as before this existed.
export async function applyExtractedFieldsToOpportunity(
  opportunityId: string,
  extractedFields: { field: ExtractableOpportunityField; value: string }[],
): Promise<void> {
  if (extractedFields.length === 0) return;

  // These are single Opportunity-level columns -- genuinely ambiguous
  // once the Opportunity has multiple projects in play (which booth
  // number? which event date?). The existing "only fill an empty field"
  // rule already provides partial protection, but doesn't stop the
  // FIRST project's document from incorrectly populating a field that
  // doesn't apply project-wide. Skip auto-apply entirely rather than
  // guess -- same 2+ named Estimates threshold scope-document-context.ts's
  // getProjectContext uses to decide multi-project is actually active.
  const estimateCount = await db.estimate.count({
    where: { opportunityId, deletedAt: null, name: { not: null } },
  });
  if (estimateCount >= 2) return;

  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    select: {
      boothNumber: true,
      boothSize: true,
      shipDate: true,
      eventStartDate: true,
      eventEndDate: true,
      siteAddress: true,
    },
  });

  function valueFor(field: ExtractableOpportunityField): string | null {
    const found = extractedFields.find((ef) => ef.field === field && ef.value.trim() !== "");
    return found ? found.value.trim() : null;
  }
  function dateFor(field: ExtractableOpportunityField): Date | null {
    const raw = valueFor(field);
    return raw ? parseFreeTextDate(raw) : null;
  }

  const data: Prisma.OpportunityUpdateInput = {};
  if (!opportunity.boothNumber) {
    const v = valueFor("boothNumber");
    if (v) data.boothNumber = v;
  }
  if (!opportunity.boothSize) {
    const v = valueFor("boothSize");
    if (v) data.boothSize = v;
  }
  if (!opportunity.siteAddress) {
    const v = valueFor("siteAddress");
    if (v) data.siteAddress = v;
  }
  if (!opportunity.shipDate) {
    const v = dateFor("shipDate");
    if (v) data.shipDate = v;
  }
  if (!opportunity.eventStartDate) {
    const v = dateFor("eventStartDate");
    if (v) data.eventStartDate = v;
  }
  if (!opportunity.eventEndDate) {
    const v = dateFor("eventEndDate");
    if (v) data.eventEndDate = v;
  }

  if (Object.keys(data).length === 0) return;
  await db.opportunity.update({ where: { id: opportunityId }, data });
}
