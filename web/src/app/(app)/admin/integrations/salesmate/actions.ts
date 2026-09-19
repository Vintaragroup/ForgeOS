"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  createCompanyFromSalesmate,
  ignoreSalesmateCompany,
  linkSalesmateCompany,
  runSalesmateSync,
  unlinkSalesmateCompany,
} from "@/lib/salesmate-sync";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";

const PAGE = "/admin/integrations/salesmate";

// Admin-only throughout -- linking decides which ForgeOS company a
// Salesmate company's contacts and deal history land on.

export async function syncNowAction() {
  const admin = await requireAdmin();
  // Never throws: a failed sync is recorded as a FAILED run, which the
  // page shows with its error.
  await runSalesmateSync({ trigger: "MANUAL", triggeredByUserId: admin.id });
  revalidatePath(PAGE);
}

export async function linkCompanyAction(salesmateId: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const result = await catchUserError(async () => {
    const companyId = String(formData.get("companyId") ?? "");
    if (!companyId) throw new UserError("Pick the ForgeOS company this is.");
    await linkSalesmateCompany(salesmateId, companyId);
  });
  if (!result) revalidatePath(PAGE);
  return result;
}

export async function createCompanyAction(salesmateId: string): Promise<ActionResult> {
  await requireAdmin();
  const result = await catchUserError(() => createCompanyFromSalesmate(salesmateId));
  if (!result) revalidatePath(PAGE);
  return result;
}

export async function ignoreCompanyAction(salesmateId: string) {
  await requireAdmin();
  await ignoreSalesmateCompany(salesmateId);
  revalidatePath(PAGE);
}

export async function unlinkCompanyAction(salesmateId: string) {
  await requireAdmin();
  await unlinkSalesmateCompany(salesmateId);
  revalidatePath(PAGE);
}
