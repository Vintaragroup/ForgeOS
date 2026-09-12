"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
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

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function emptyToDate(value: FormDataEntryValue | null): Date | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : new Date(str);
}
