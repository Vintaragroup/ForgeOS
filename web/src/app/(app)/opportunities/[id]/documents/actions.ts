"use server";

import { revalidatePath } from "next/cache";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import {
  assignDocumentEstimate,
  deleteDocument,
  finalizeUploadedDocument,
  updateDocumentType,
} from "@/lib/document-service";
import { analyzeDocument } from "@/lib/ai/analyze-document";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import type { DocumentType } from "@/generated/prisma/enums";

// Records a Document row for a file the browser already uploaded directly
// to Blob (see upload-token/route.ts and document-upload-form.tsx) --
// bytes never pass through this action or any Server Action's own request
// body, which is the fix for the 413 a 7.2MB/6-file upload used to hit
// well under next.config.ts's 40MB Server Action limit (Vercel Functions
// enforce their own, lower request-body ceiling ahead of that config).
// Called once per uploaded file, same one-at-a-time posture the old
// byte-carrying version had -- a mid-batch failure still leaves the
// earlier files' Document rows already created rather than all-or-nothing.
export async function finalizeDocumentUploadAction(
  opportunityId: string,
  data: { storageKey: string; filename: string; documentType: string },
) {
  const user = await requireOpportunityAccess(opportunityId);
  await finalizeUploadedDocument(opportunityId, {
    storageKey: data.storageKey,
    filename: data.filename,
    documentType: data.documentType as DocumentType,
    uploadedById: user.id,
  });
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function deleteDocumentAction(opportunityId: string, documentId: string) {
  await requireOpportunityAccess(opportunityId);
  await deleteDocument(opportunityId, documentId);
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function updateDocumentTypeAction(opportunityId: string, documentId: string, formData: FormData) {
  await requireOpportunityAccess(opportunityId);
  const documentType = String(formData.get("documentType") ?? "") as DocumentType;
  await updateDocumentType(opportunityId, documentId, documentType);
  revalidatePath(`/opportunities/${opportunityId}`);
}

// Manual per-document project hint, shown only once an Opportunity has
// 2+ named Estimates -- see Document.estimateId's own schema comment.
// Empty string means "let AI classify," stored as null.
export async function assignDocumentEstimateAction(opportunityId: string, documentId: string, formData: FormData) {
  await requireOpportunityAccess(opportunityId);
  const rawEstimateId = String(formData.get("estimateId") ?? "").trim();
  await assignDocumentEstimate(opportunityId, documentId, rawEstimateId || null);
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function analyzeDocumentAction(opportunityId: string, documentId: string) {
  const user = await requireOpportunityAccess(opportunityId);
  try {
    await analyzeDocument(opportunityId, documentId, user.id);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable document analysis.");
    }
    throw err;
  }
  revalidatePath(`/opportunities/${opportunityId}`);
}
