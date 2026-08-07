"use server";

import { db } from "@/lib/db";
import { OpportunityStage } from "@/generated/prisma/enums";
import { changeOpportunityStage } from "@/lib/opportunity-service";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createOpportunity(formData: FormData) {
  const showName = String(formData.get("showName") ?? "").trim();
  const companyId = String(formData.get("companyId") ?? "").trim();
  if (!showName) throw new Error("Show name is required");
  if (!companyId) throw new Error("Company is required");

  const opportunity = await db.opportunity.create({
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

  // First stage event, so the pipeline history always starts from a known point.
  await db.stageChangeEvent.create({
    data: { opportunityId: opportunity.id, fromStage: null, toStage: opportunity.stage },
  });

  revalidatePath("/opportunities");
  redirect(`/opportunities/${opportunity.id}`);
}

export async function updateOpportunity(id: string, formData: FormData) {
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

export async function changeStage(id: string, formData: FormData) {
  const toStage = String(formData.get("stage")) as OpportunityStage;
  const note = emptyToNull(formData.get("note"));

  await changeOpportunityStage(id, toStage, note);

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${id}`);
}

export async function deleteOpportunity(id: string) {
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
