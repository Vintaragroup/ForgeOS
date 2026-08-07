// Framework-agnostic business logic, kept separate from
// app/opportunities/actions.ts (which only adds the Next.js-specific
// concerns: revalidatePath, redirect). Server Actions call redirect()
// unconditionally, which throws outside a real request context -- pulling
// the actual logic out here is what makes it testable at all.

import { db } from "@/lib/db";
import { OpportunityStage } from "@/generated/prisma/enums";

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
