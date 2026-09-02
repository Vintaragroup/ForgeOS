"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere, requireOpportunityAccess } from "@/lib/opportunity-access";
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

// The dashboard's "what would you like to tackle today" bar -- a router,
// not a live conversation. The real chat system (ChatThread.opportunityId
// is a required, unique column) only ever runs inside ONE opportunity's
// context; there's no account-wide assistant yet. So typing something
// here finds the opportunity you almost certainly mean and drops you
// straight into ITS chat widget with your text already sitting in the
// input (see ChatWidget's autoOpen/initialInput props) -- one exact
// showName match jumps directly there; anything less certain (zero
// matches, or several) falls back to the existing multi-entity /search
// page instead of guessing, since a wrong silent redirect is worse than
// one extra click through real search results. Deliberately reuses
// /search's own opportunity-matching shape (case-insensitive
// showName contains, access-scoped) rather than inventing a second,
// possibly-diverging way to find an opportunity by name.
export async function routeDashboardQueryAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const term = String(formData.get("query") ?? "").trim();
  if (!term) redirect("/search");

  const matches = await db.opportunity.findMany({
    where: { deletedAt: null, showName: { contains: term, mode: "insensitive" }, ...opportunityAccessWhere(user) },
    select: { id: true },
    take: 2,
  });

  if (matches.length === 1) {
    redirect(`/opportunities/${matches[0].id}?ask=${encodeURIComponent(term)}`);
  }
  redirect(`/search?q=${encodeURIComponent(term)}`);
}
