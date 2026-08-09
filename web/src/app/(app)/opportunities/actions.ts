"use server";

import { db } from "@/lib/db";
import { OpportunityStage } from "@/generated/prisma/enums";
import { changeOpportunityStage } from "@/lib/opportunity-service";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// No access check -- creating a new Opportunity has nothing to authorize
// against yet. The creator isn't auto-added as a collaborator: ownership
// (ownerId) already grants access on its own (see opportunity-access.ts),
// a separate collaborator row would be redundant.
export async function createOpportunity(formData: FormData) {
  const showName = String(formData.get("showName") ?? "").trim();
  const companyId = String(formData.get("companyId") ?? "").trim();
  if (!showName) throw new Error("Show name is required");
  if (!companyId) throw new Error("Company is required");

  const collaboratorIds = formData.getAll("collaboratorIds").map(String);

  const opportunity = await db.opportunity.create({
    data: {
      showName,
      companyId,
      boothNumber: emptyToNull(formData.get("boothNumber")),
      primaryContactId: emptyToNull(formData.get("primaryContactId")),
      ownerId: emptyToNull(formData.get("ownerId")),
      targetMoveIn: emptyToDate(formData.get("targetMoveIn")),
      targetMoveOut: emptyToDate(formData.get("targetMoveOut")),
      collaborators: { create: collaboratorIds.map((userId) => ({ userId })) },
    },
  });

  // First stage event, so the pipeline history always starts from a known point.
  await db.stageChangeEvent.create({
    data: { opportunityId: opportunity.id, fromStage: null, toStage: opportunity.stage },
  });

  revalidatePath("/opportunities");
  redirect(`/opportunities/${opportunity.id}`);
}

export async function updateOpportunity(id: string, formData: FormData) {
  await requireOpportunityAccess(id);

  const showName = String(formData.get("showName") ?? "").trim();
  const companyId = String(formData.get("companyId") ?? "").trim();
  if (!showName) throw new Error("Show name is required");
  if (!companyId) throw new Error("Company is required");

  await db.opportunity.update({
    where: { id },
    data: {
      showName,
      companyId,
      boothNumber: emptyToNull(formData.get("boothNumber")),
      primaryContactId: emptyToNull(formData.get("primaryContactId")),
      ownerId: emptyToNull(formData.get("ownerId")),
      targetMoveIn: emptyToDate(formData.get("targetMoveIn")),
      targetMoveOut: emptyToDate(formData.get("targetMoveOut")),
    },
  });

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${id}`);
  redirect(`/opportunities/${id}`);
}

// Diffs the submitted checkbox list against the current collaborator
// rows rather than delete-then-recreate-all -- keeps createdAt stable for
// anyone who stays a collaborator across an edit.
export async function updateCollaborators(id: string, formData: FormData) {
  await requireOpportunityAccess(id);

  const submittedIds = new Set(formData.getAll("collaboratorIds").map(String));
  const existing = await db.opportunityCollaborator.findMany({
    where: { opportunityId: id },
    select: { userId: true },
  });
  const existingIds = new Set(existing.map((c) => c.userId));

  const toAdd = [...submittedIds].filter((userId) => !existingIds.has(userId));
  const toRemove = [...existingIds].filter((userId) => !submittedIds.has(userId));

  await db.$transaction([
    ...toAdd.map((userId) => db.opportunityCollaborator.create({ data: { opportunityId: id, userId } })),
    ...(toRemove.length > 0
      ? [db.opportunityCollaborator.deleteMany({ where: { opportunityId: id, userId: { in: toRemove } } })]
      : []),
  ]);

  revalidatePath(`/opportunities/${id}`);
}

export async function changeStage(id: string, formData: FormData) {
  await requireOpportunityAccess(id);

  const toStage = String(formData.get("stage")) as OpportunityStage;
  const note = emptyToNull(formData.get("note"));

  await changeOpportunityStage(id, toStage, note);

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${id}`);
}

export async function deleteOpportunity(id: string) {
  await requireOpportunityAccess(id);

  await db.opportunity.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/opportunities");
  redirect("/opportunities");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function emptyToDate(value: FormDataEntryValue | null): Date | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : new Date(str);
}
