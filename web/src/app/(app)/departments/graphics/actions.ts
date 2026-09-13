"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { createArtworkOrder, canStartArtworkOnboarding } from "@/lib/artwork-order-service";
import { notifyClientInvited } from "@/lib/artwork-notifications";
import { NEW_COMPANY_VALUE } from "@/lib/opportunity-new-company";

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
  // Rides along on the redirect (?invite=) so the order page can show the
  // real link once as a fallback -- Resend can't currently deliver, and
  // this is the only moment the raw token is ever knowable (see
  // notifyClientInvited's own comment).
  const link = await notifyClientInvited(order.id, contact.email);

  redirect(`/artwork/${order.id}?invite=${encodeURIComponent(link)}`);
}

// Companion to startArtworkOrderFromDashboardAction above: an opportunity
// often exists before its show does (or gets created standalone and only
// later turns out to belong to a whole-show contract) -- this lets a
// Graphics user close that gap without leaving the dashboard, by linking an
// already-unassigned opportunity to an already-existing show. Reuses the
// exact same access rule (department-wide OR ownership) as the rest of
// this file, and the same update shows/actions.ts's own
// assignOpportunityToShowAction performs -- just reachable from here too,
// with department-wide access rather than only owner/collaborator/admin.
export async function linkOpportunityToShowFromDashboardAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");

  const showId = String(formData.get("showId") ?? "").trim();
  const opportunityId = String(formData.get("opportunityId") ?? "").trim();
  if (!showId) throw new Error("Select a show to link this opportunity to.");
  if (!opportunityId) throw new Error("Select an opportunity to link.");

  const hasAccess = (await canAccessOpportunity(user, opportunityId)) || canAccessArtworkOrdersViaDepartment(user);
  if (!hasAccess) throw new Error("You don't have access to this opportunity.");

  const [show, opportunity] = await Promise.all([
    db.show.findUniqueOrThrow({ where: { id: showId }, select: { name: true } }),
    db.opportunity.findUniqueOrThrow({ where: { id: opportunityId }, select: { showName: true, company: { select: { name: true } } } }),
  ]);
  // Reconcile showName with the show being linked -- but ONLY when it still
  // looks auto-generated (exactly the bare company name, onboardNewClient
  // FromDashboardAction's own standalone-deal fallback above). A showName
  // someone actually typed or edited is left alone: this is closing a gap
  // this dashboard itself created, not a general "keep showName in sync
  // with its show" rule applied to every opportunity that gets linked here.
  const showName = opportunity.showName === opportunity.company.name ? `${opportunity.company.name} @ ${show.name}` : undefined;

  await db.opportunity.update({ where: { id: opportunityId }, data: { showId, ...(showName ? { showName } : {}) } });

  // Straight into the "Start an artwork order" picker's step 2 for the same
  // opportunity -- link-then-invite is one continuous task from a Graphics
  // user's perspective, not two separate trips back to this page.
  redirect(`/departments/graphics?opportunityId=${opportunityId}`);
}

// The real front door for a genuinely NEW exhibitor: before this, a
// Graphics employee had no way to onboard one at all -- their department
// nav has no Companies/Contacts/Opportunities links (deliberately, so they
// never see cost/margin data on those pages), so a brand-new client meant
// asking an admin to create the Company/Contact/Opportunity first. This
// collapses that whole chain into one submit: reuses the exact same
// "+ New client" Company-resolution logic opportunities/actions.ts's
// createOpportunity already has (NEW_COMPANY_VALUE, company-field-with-
// create.tsx) rather than re-deriving it, creates a real Contact
// (email required here, unlike Contact creation in general, since the
// whole point is inviting them to the portal), and an Opportunity linked
// to both -- then redirects into the same "Start an artwork order" step 2
// the other two actions in this file land on.
//
// Restricted to GR-department members and admins specifically (not the
// broader "owner/collaborator OR department" rule the other two actions
// use) -- there's no existing opportunity to already have ownership of
// here, so that fallback has nothing to check.
export async function onboardNewClientFromDashboardAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  if (!isAdmin && !canAccessArtworkOrdersViaDepartment(user)) {
    throw new Error("You don't have access to onboard a new client.");
  }

  let companyId = String(formData.get("companyId") ?? "").trim();
  const contactName = String(formData.get("contactName") ?? "").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const showId = String(formData.get("showId") ?? "").trim() || null;
  if (!companyId) throw new Error("Select or name a client company.");
  if (!contactName) throw new Error("Contact name is required.");
  if (!contactEmail) throw new Error("Contact email is required to invite them to the artwork portal.");

  let companyName: string;
  if (companyId === NEW_COMPANY_VALUE) {
    const newCompanyName = String(formData.get("newCompanyName") ?? "").trim();
    if (!newCompanyName) throw new Error("New client name is required.");
    const company = await db.company.create({ data: { name: newCompanyName } });
    companyId = company.id;
    companyName = company.name;
  } else {
    const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
    companyName = company.name;
  }

  const show = showId ? await db.show.findUniqueOrThrow({ where: { id: showId }, select: { name: true } }) : null;

  const contact = await db.contact.create({
    data: { name: contactName, email: contactEmail, role: "CLIENT_CONTACT", companyId },
  });

  // No manual "show name" field in this form (unlike the full New
  // Opportunity page, which makes you re-type it even right after picking
  // a Show from a dropdown) -- derived here instead, since the whole point
  // of this quick-onboard box is fewer redundant fields, not a smaller
  // version of the same form.
  const opportunity = await db.opportunity.create({
    data: {
      companyId,
      showId,
      showName: show ? `${companyName} @ ${show.name}` : companyName,
      primaryContactId: contact.id,
      projectType: "TRADESHOW_EXHIBIT",
    },
  });

  redirect(`/departments/graphics?opportunityId=${opportunity.id}`);
}
