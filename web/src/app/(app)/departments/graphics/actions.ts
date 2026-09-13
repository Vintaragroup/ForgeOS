"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { createArtworkOrder, canStartArtworkOnboarding } from "@/lib/artwork-order-service";
import { notifyClientInvited } from "@/lib/artwork-notifications";

// Graphics-dashboard counterpart to opportunities/[id]/artwork-actions.ts's
// inviteToArtworkPortalAction -- same underlying operation (start an
// ArtworkOrder, email the client its portal link), but reachable without
// leaving the Graphics dashboard, and grantable to any GR-department member
// even when they're not this opportunity's own owner/collaborator --
// matching the same department-wide grant department-access.ts already
// gives for VIEWING artwork orders. Falls back to the ordinary
// owner/collaborator/admin check for anyone else who somehow lands here
// (e.g. a non-GR employee who owns the opportunity), so this is strictly an
// addition to who can invite, never a narrowing.
export async function startArtworkOrderFromDashboardAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");

  const opportunityId = String(formData.get("opportunityId") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim();
  if (!opportunityId) throw new Error("Select an opportunity to start an artwork order for.");
  if (!contactId) throw new Error("Select a client contact to invite.");

  const hasAccess = (await canAccessOpportunity(user, opportunityId)) || canAccessArtworkOrdersViaDepartment(user);
  if (!hasAccess) throw new Error("You don't have access to this opportunity.");

  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    select: { companyId: true, stage: true, showId: true },
  });
  // Mirrors the opportunity page's own gate -- enforced here too since this
  // action is independently reachable, not just gated by what the picker
  // above happens to list.
  if (!canStartArtworkOnboarding(opportunity)) {
    throw new Error("This opportunity needs to be Won, or linked to a show, before starting an artwork order.");
  }
  // Same cross-resource check as inviteToArtworkPortalAction: a contactId
  // submitted from the form must actually belong to THIS opportunity's
  // company.
  const contact = await db.contact.findFirstOrThrow({ where: { id: contactId, companyId: opportunity.companyId } });
  if (!contact.email) throw new Error(`${contact.name} has no email on file -- add one before inviting.`);

  const order = await createArtworkOrder(opportunityId);
  await notifyClientInvited(order.id, contact.email);

  redirect(`/artwork/${order.id}`);
}
