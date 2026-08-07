"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createProposalTemplate(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Template name is required");

  await db.proposalTemplate.create({
    data: {
      name,
      brandingConfig: buildBrandingConfig(formData),
      layoutConfig: buildLayoutConfig(formData),
    },
  });

  revalidatePath("/catalog/proposal-templates");
  redirect("/catalog/proposal-templates");
}

export async function updateProposalTemplate(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Template name is required");

  await db.proposalTemplate.update({
    where: { id },
    data: {
      name,
      brandingConfig: buildBrandingConfig(formData),
      layoutConfig: buildLayoutConfig(formData),
    },
  });

  revalidatePath("/catalog/proposal-templates");
  redirect("/catalog/proposal-templates");
}

export async function deleteProposalTemplate(id: string) {
  await db.proposalTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/catalog/proposal-templates");
  redirect("/catalog/proposal-templates");
}

function buildBrandingConfig(formData: FormData) {
  const color = emptyToNull(formData.get("brandColor"));
  const logoUrl = emptyToNull(formData.get("logoUrl"));
  if (!color && !logoUrl) return undefined;
  return { color, logoUrl };
}

function buildLayoutConfig(formData: FormData) {
  const note = emptyToNull(formData.get("layoutNote"));
  if (!note) return undefined;
  return { note };
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
