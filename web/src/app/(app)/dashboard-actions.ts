"use server";

import { db } from "@/lib/db";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import type { DeadlineActionStatus } from "@/generated/prisma/enums";
import { revalidatePath } from "next/cache";

// Lightweight acknowledgment against one Dashboard "upcoming deadline" --
// not a real reminders/notifications engine, see DeadlineAction's schema
// comment. Self-checks access rather than trusting the Dashboard page's own
// gate, matching every other Server Action in this app since B20/opportunity
// access were added.
export async function recordDeadlineActionAction(
  opportunityId: string,
  dedupeKey: string,
  status: DeadlineActionStatus,
) {
  const user = await requireOpportunityAccess(opportunityId);
  await db.deadlineAction.upsert({
    where: { opportunityId_dedupeKey: { opportunityId, dedupeKey } },
    create: { opportunityId, dedupeKey, status, actedById: user.id },
    update: { status, actedById: user.id },
  });
  revalidatePath("/");
}
