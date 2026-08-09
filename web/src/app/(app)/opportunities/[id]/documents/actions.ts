"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { deleteDocument, uploadDocument } from "@/lib/document-service";
import { summarizeDocument } from "@/lib/ai/document-summary-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import type { DocumentType } from "@/generated/prisma/enums";

export async function uploadDocumentAction(opportunityId: string, formData: FormData) {
  const user = await getCurrentUser();
  const file = formData.get("file");
  const documentType = String(formData.get("documentType") ?? "OTHER") as DocumentType;

  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Choose a file to upload.");
  }

  await uploadDocument(opportunityId, { file, documentType, uploadedById: user?.id ?? null });

  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function deleteDocumentAction(opportunityId: string, documentId: string) {
  await deleteDocument(documentId);
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function analyzeDocumentAction(opportunityId: string, documentId: string) {
  try {
    await summarizeDocument(documentId);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable document analysis.");
    }
    throw err;
  }
  revalidatePath(`/opportunities/${opportunityId}`);
}
