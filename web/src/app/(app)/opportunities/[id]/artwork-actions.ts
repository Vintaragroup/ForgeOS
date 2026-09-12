"use server";

import { redirect } from "next/navigation";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { createArtworkOrder } from "@/lib/artwork-order-service";
import { notifyClientInvited } from "@/lib/artwork-notifications";
import { db } from "@/lib/db";

// Starts a new artwork order for this opportunity (status INVITED) and
// emails the client a magic-link portal invite -- see
// artwork-order-service.ts's createArtworkOrder and
// artwork-notifications.ts's notifyClientInvited (a no-op-with-a-warning if
// RESEND_API_KEY isn't set yet, so the account rep can still hand the
// client the link manually).
export async function inviteToArtworkPortalAction(opportunityId: string, formData: FormData) {
  await requireOpportunityAccess(opportunityId);

  const contactId = String(formData.get("contactId") ?? "").trim();
  if (!contactId) throw new Error("Select a client contact to invite.");
  // Cross-resource check: a contactId submitted from the form must actually
  // belong to THIS opportunity's company, not just be some valid Contact id
  // -- same class of gap opportunity-access.ts's other assertBelongsTo*
  // helpers exist to close.
  const opportunity = await db.opportunity.findUniqueOrThrow({ where: { id: opportunityId }, select: { companyId: true } });
  const contact = await db.contact.findFirstOrThrow({ where: { id: contactId, companyId: opportunity.companyId } });
  if (!contact.email) throw new Error(`${contact.name} has no email on file -- add one before inviting.`);

  const order = await createArtworkOrder(opportunityId);
  await notifyClientInvited(order.id, contact.email);

  redirect(`/artwork/${order.id}`);
}
