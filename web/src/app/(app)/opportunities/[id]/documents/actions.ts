"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { assignDocumentEstimate, deleteDocument, updateDocumentType, uploadDocument } from "@/lib/document-service";
import { analyzeDocument } from "@/lib/ai/analyze-document";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import type { DocumentType } from "@/generated/prisma/enums";

// Accepts one or many files under the same "file" field (the drag-and-drop
// dropzone sets a real multi-file FileList on the input) -- uploaded one
// at a time, not Promise.all, so a large batch doesn't try to write every
// file to disk concurrently and a mid-batch failure leaves the earlier
// files already saved rather than all-or-nothing.
export async function uploadDocumentAction(opportunityId: string, formData: FormData) {
  await requireOpportunityAccess(opportunityId);
  const user = await getCurrentUser();
  const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const documentType = String(formData.get("documentType") ?? "OTHER") as DocumentType;

  if (files.length === 0) {
    throw new Error("Choose at least one file to upload.");
  }

  for (const file of files) {
    await uploadDocument(opportunityId, { file, documentType, uploadedById: user?.id ?? null });
  }

  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function deleteDocumentAction(opportunityId: string, documentId: string) {
  await requireOpportunityAccess(opportunityId);
  await deleteDocument(documentId);
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function updateDocumentTypeAction(opportunityId: string, documentId: string, formData: FormData) {
  await requireOpportunityAccess(opportunityId);
  const documentType = String(formData.get("documentType") ?? "") as DocumentType;
  await updateDocumentType(documentId, documentType);
  revalidatePath(`/opportunities/${opportunityId}`);
}

// Manual per-document project hint, shown only once an Opportunity has
// 2+ named Estimates -- see Document.estimateId's own schema comment.
// Empty string means "let AI classify," stored as null.
export async function assignDocumentEstimateAction(opportunityId: string, documentId: string, formData: FormData) {
  await requireOpportunityAccess(opportunityId);
  const rawEstimateId = String(formData.get("estimateId") ?? "").trim();
  await assignDocumentEstimate(documentId, rawEstimateId || null);
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function analyzeDocumentAction(opportunityId: string, documentId: string) {
  const user = await requireOpportunityAccess(opportunityId);
  try {
    await analyzeDocument(documentId, user.id);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable document analysis.");
    }
    throw err;
  }
  revalidatePath(`/opportunities/${opportunityId}`);
}
