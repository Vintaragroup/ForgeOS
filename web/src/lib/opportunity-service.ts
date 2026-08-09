// Framework-agnostic business logic, kept separate from
// app/opportunities/actions.ts (which only adds the Next.js-specific
// concerns: revalidatePath, redirect). Server Actions call redirect()
// unconditionally, which throws outside a real request context -- pulling
// the actual logic out here is what makes it testable at all.

import { db } from "@/lib/db";
import { OpportunityStage } from "@/generated/prisma/enums";
import { createEstimateVersion } from "@/lib/estimate-service";

export async function changeOpportunityStage(
  id: string,
  toStage: OpportunityStage,
  note: string | null,
) {
  const current = await db.opportunity.findUniqueOrThrow({ where: { id } });

  const [updated] = await db.$transaction([
    db.opportunity.update({ where: { id }, data: { stage: toStage } }),
    db.stageChangeEvent.create({
      data: { opportunityId: id, fromStage: current.stage, toStage, note },
    }),
  ]);

  return updated;
}

export async function convertOpportunityToEstimate(opportunityId: string) {
  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
  });

  const [estimate] = await db.$transaction([
    db.estimate.create({ data: { opportunityId } }),
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
