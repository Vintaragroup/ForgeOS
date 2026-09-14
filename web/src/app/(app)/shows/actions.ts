"use server";

import { db } from "@/lib/db";
import { requireAdmin, getCurrentUser } from "@/lib/auth";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { rolloverShow } from "@/lib/artwork-hub";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createShow(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Show name is required");

  const show = await db.show.create({
    data: {
      name,
      venue: emptyToNull(formData.get("venue")),
      eventStartDate: emptyToDate(formData.get("eventStartDate")),
      eventEndDate: emptyToDate(formData.get("eventEndDate")),
    },
  });

  revalidatePath("/shows");
  redirect(`/shows/${show.id}`);
}

export async function updateShow(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Show name is required");

  await db.show.update({
    where: { id },
    data: {
      name,
      venue: emptyToNull(formData.get("venue")),
      eventStartDate: emptyToDate(formData.get("eventStartDate")),
      eventEndDate: emptyToDate(formData.get("eventEndDate")),
      escalationContactId: emptyToNull(formData.get("escalationContactId")),
    },
  });

  revalidatePath("/shows");
  revalidatePath(`/shows/${id}`);
  redirect(`/shows/${id}`);
}

// Admin-only -- same rationale as companies/actions.ts's deleteCompany:
// widest-blast-radius, hardest-to-reverse action on data every one of this
// show's client Opportunities can see (though the Opportunities themselves
// aren't deleted, just unlinked -- see the ON DELETE SET NULL default on
// Opportunity.showId).
export async function deleteShow(id: string) {
  await requireAdmin();
  await db.show.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/shows");
  redirect("/shows");
}

// Links an EXISTING, currently-unassigned Opportunity to this Show. Real
// access check on the opportunityId submitted from the form -- same
// cross-resource-ID gap requireOpportunityAccess exists to close everywhere
// else in this app; a Show's own "any authenticated user can create/edit"
// posture (mirroring Company) doesn't imply the caller can reach into an
// arbitrary Opportunity they don't otherwise have access to.
export async function assignOpportunityToShowAction(showId: string, formData: FormData) {
  const opportunityId = String(formData.get("opportunityId") ?? "").trim();
  if (!opportunityId) throw new Error("Select an opportunity to assign.");
  await requireOpportunityAccess(opportunityId);

  await db.opportunity.update({ where: { id: opportunityId }, data: { showId } });
  revalidatePath(`/shows/${showId}`);
}

// Bulk-creates a fresh Opportunity + ArtworkOrder set under this
// (target) show for every client that was on `sourceShowId` -- the
// Graphics team's own annual pattern of returning clients reusing prior
// artwork (see rolloverArtworkOrder's own comment). A bulk
// Graphics-operations action, not a per-opportunity sales one, so it's
// gated to GR-department/admin rather than reusing
// requireOpportunityAccess's per-resource check the way
// assignOpportunityToShowAction above does -- the caller here touches
// many opportunities/companies they may not individually own.
//
// Nothing client-facing happens: every created ArtworkOrder starts at its
// normal INVITED default with no ArtworkPortalInvite -- inviting a client
// stays the same deliberate, per-client action it already is
// (inviteToArtworkPortalAction), unchanged by this.
//
// Idempotent -- safe to click twice. A returning client already rolled
// into the target show (matched by companyId) is skipped, and within that
// opportunity each piece is deduped by graphicCode, so a partial prior run
// (or someone already having drafted artwork orders on the target
// opportunity by hand) doesn't get duplicated.
export async function rolloverShowAction(targetShowId: string, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  if (!isAdmin && !canAccessArtworkOrdersViaDepartment(user)) {
    throw new Error("Only Graphics department staff or an admin can roll over a show.");
  }

  const sourceShowId = String(formData.get("sourceShowId") ?? "").trim();
  if (!sourceShowId) throw new Error("Select a show to roll over clients from.");
  if (sourceShowId === targetShowId) throw new Error("Source and target show must be different.");

  const actor = { type: "EXPO" as const, userId: user.id };

  const { opportunitiesCreated, piecesCreated } = await rolloverShow({ sourceShowId, targetShowId }, actor);

  revalidatePath(`/shows/${targetShowId}`);
  redirect(`/shows/${targetShowId}?rolledOverOpportunities=${opportunitiesCreated}&rolledOverPieces=${piecesCreated}`);
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function emptyToDate(value: FormDataEntryValue | null): Date | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : new Date(str);
}
