"use server";

import { db } from "@/lib/db";
import { OpportunityStage, ProjectType, BoothType, BoothSpace, type CloseReason } from "@/generated/prisma/enums";
import { changeOpportunityStage } from "@/lib/opportunity-service";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { EXTRACTABLE_OPPORTUNITY_FIELDS, type ExtractableOpportunityField } from "@/lib/ai/document-summary-service";
import { parseFreeTextDate } from "@/lib/citation";
import { statusRedirectPath } from "@/lib/action-status";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const DATE_FIELDS = new Set<ExtractableOpportunityField>(["shipDate", "eventStartDate", "eventEndDate"]);

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
  const taxRateId = await resolveOpportunityTaxRateId(formData.get("taxRateId"), companyId);

  const opportunity = await db.opportunity.create({
    data: {
      showName,
      companyId,
      projectType: String(formData.get("projectType") ?? "TRADESHOW_EXHIBIT") as ProjectType,
      boothNumber: emptyToNull(formData.get("boothNumber")),
      boothSize: emptyToNull(formData.get("boothSize")),
      boothSpace: emptyToNull(formData.get("boothSpace")) as BoothSpace | null,
      boothType: emptyToNull(formData.get("boothType")) as BoothType | null,
      shipDate: emptyToDate(formData.get("shipDate")),
      venue: emptyToNull(formData.get("venue")),
      eventStartDate: emptyToDate(formData.get("eventStartDate")),
      eventEndDate: emptyToDate(formData.get("eventEndDate")),
      siteAddress: emptyToNull(formData.get("siteAddress")),
      projectDetails: emptyToNull(formData.get("projectDetails")),
      primaryContactId: emptyToNull(formData.get("primaryContactId")),
      ownerId: emptyToNull(formData.get("ownerId")),
      targetMoveIn: emptyToDate(formData.get("targetMoveIn")),
      targetMoveOut: emptyToDate(formData.get("targetMoveOut")),
      taxRateId,
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
      projectType: String(formData.get("projectType") ?? "TRADESHOW_EXHIBIT") as ProjectType,
      boothNumber: emptyToNull(formData.get("boothNumber")),
      boothSize: emptyToNull(formData.get("boothSize")),
      boothSpace: emptyToNull(formData.get("boothSpace")) as BoothSpace | null,
      boothType: emptyToNull(formData.get("boothType")) as BoothType | null,
      shipDate: emptyToDate(formData.get("shipDate")),
      venue: emptyToNull(formData.get("venue")),
      eventStartDate: emptyToDate(formData.get("eventStartDate")),
      eventEndDate: emptyToDate(formData.get("eventEndDate")),
      siteAddress: emptyToNull(formData.get("siteAddress")),
      projectDetails: emptyToNull(formData.get("projectDetails")),
      primaryContactId: emptyToNull(formData.get("primaryContactId")),
      ownerId: emptyToNull(formData.get("ownerId")),
      targetMoveIn: emptyToDate(formData.get("targetMoveIn")),
      targetMoveOut: emptyToDate(formData.get("targetMoveOut")),
      taxRateId: emptyToNull(formData.get("taxRateId")),
    },
  });

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${id}`);
  redirect(statusRedirectPath(`/opportunities/${id}`, { success: "Details saved." }));
}

// Accepting an AI-suggested onboarding field (opportunities/[id]/page.tsx's
// "Suggested from documents" panel, computed from DocumentSummary.
// extractedFields) -- mirrors updateDocumentTypeAction's accept-a-
// suggestion shape: the value only ever lands on the Opportunity when a
// human clicks Accept, never automatically at analysis time. `field` is
// checked against the fixed allowlist rather than trusted from the form
// post, since it's used as a dynamic Prisma update key.
export async function applyOpportunityFieldSuggestionAction(
  opportunityId: string,
  field: string,
  formData: FormData,
) {
  await requireOpportunityAccess(opportunityId);

  if (!EXTRACTABLE_OPPORTUNITY_FIELDS.includes(field as ExtractableOpportunityField)) {
    throw new Error(`Not a suggestible field: ${field}`);
  }

  const rawValue = String(formData.get("value") ?? "").trim();
  if (!rawValue) return;

  const value: string | Date | null = DATE_FIELDS.has(field as ExtractableOpportunityField)
    ? parseFreeTextDate(rawValue)
    : rawValue;
  if (value === null) return; // unparseable date -- leave the field untouched rather than write garbage

  await db.opportunity.update({ where: { id: opportunityId }, data: { [field]: value } });

  revalidatePath(`/opportunities/${opportunityId}`);
  redirect(statusRedirectPath(`/opportunities/${opportunityId}`, { success: "Suggested value applied." }));
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
  // Redirect back with a query param, not just revalidatePath -- this
  // action previously gave zero visible feedback on save (confirmed live:
  // the checkboxes already reflected the submitted state via
  // defaultChecked, so a revalidated page looked byte-for-byte identical,
  // reading as "nothing happened" even though the save succeeded). Kept as
  // its own dedicated param rather than statusRedirectPath's generic
  // success/error (action-status.ts) -- this one also has to force the
  // Collaborators CollapsibleSection back open after the redirect, since
  // a fresh server render otherwise re-collapses it (defaultOpen is only
  // an initial value, not persisted client state), which a page-top
  // generic banner alone wouldn't fix.
  redirect(`/opportunities/${id}?collaboratorsUpdated=1#collaborators`);
}

export async function changeStage(id: string, formData: FormData) {
  await requireOpportunityAccess(id);

  const toStage = String(formData.get("stage")) as OpportunityStage;
  const note = emptyToNull(formData.get("note"));
  // Only meaningful when toStage is WON/LOST -- changeOpportunityStage
  // itself ignores these for any other target stage, so no branching
  // needed here.
  const closeReason = emptyToNull(formData.get("closeReason")) as CloseReason | null;
  const closeReasonDetail = emptyToNull(formData.get("closeReasonDetail"));

  await changeOpportunityStage(id, toStage, note, closeReason, closeReasonDetail);

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${id}`);
  redirect(statusRedirectPath(`/opportunities/${id}`, { success: "Stage updated." }));
}

export async function deleteOpportunity(id: string) {
  await requireOpportunityAccess(id);

  await db.opportunity.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/opportunities");
  redirect("/opportunities");
}

// The "new opportunity" form's taxRateId select offers three states: blank
// (inherit the company's default), the "__none__" sentinel (explicitly no
// tax), or a concrete TaxRate id. A plain emptyToNull can't tell "inherit"
// apart from "explicit none", hence this dedicated resolver -- only used at
// creation time, since after that the stored value is already concrete and
// updateOpportunity's plain emptyToNull is unambiguous.
async function resolveOpportunityTaxRateId(
  value: FormDataEntryValue | null,
  companyId: string,
): Promise<string | null> {
  const str = String(value ?? "").trim();
  if (str === "__none__") return null;
  if (str !== "") return str;

  const company = await db.company.findUnique({ where: { id: companyId }, select: { taxRateId: true } });
  return company?.taxRateId ?? null;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function emptyToDate(value: FormDataEntryValue | null): Date | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : new Date(str);
}
