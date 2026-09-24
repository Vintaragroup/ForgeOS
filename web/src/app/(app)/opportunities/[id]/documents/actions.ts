"use server";

import { revalidatePath } from "next/cache";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import {
  assignDocumentEstimate,
  deleteDocument,
  finalizeUploadedDocument,
  setDocumentSupersedes,
  updateDocumentType,
} from "@/lib/document-service";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";
import { db } from "@/lib/db";
import { isPricedDocumentType } from "@/lib/recosting";
import { analyzeDocument } from "@/lib/ai/analyze-document";
import { compareDrawingToPredecessor } from "@/lib/ai/drawing-comparison-service";
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

// "This replaces …" -- the link a version label is derived from rather
// than typed. Returns its refusal instead of throwing, because every way
// this can fail is something the person can fix on the form (the wrong
// document picked, a chain that would fork or loop), and Next.js redacts
// thrown Server Action errors in production.
export async function setDocumentSupersedesAction(
  opportunityId: string,
  documentId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return catchUserError(async () => {
    const user = await requireOpportunityAccess(opportunityId);
    const raw = String(formData.get("supersedesId") ?? "").trim();
    await setDocumentSupersedes(opportunityId, documentId, raw || null);

    // Saying "this replaces that" IS the request to be told what changed
    // -- there is no other reason to link two priced documents. Making
    // it a second, separate click is how a revised quote sat unread with
    // nothing saying so. Only on linking, never on every upload, so the
    // spend follows a stated intent.
    if (raw) await analyzeIfWorthIt(opportunityId, documentId, user.id);

    revalidatePath(`/opportunities/${opportunityId}`);
  });
}

// Best-effort, and deliberately quiet: the link is the thing the person
// asked for and it has already been saved. A failed or unconfigured
// analysis leaves the document in a state the page reports for itself
// ("couldn't be read", "nothing can be compared yet"), which is a better
// place to learn it than an error on a form about something else.
async function analyzeIfWorthIt(opportunityId: string, documentId: string, userId: string) {
  const doc = await db.document.findFirst({
    where: { id: documentId, opportunityId, deletedAt: null },
    select: { documentType: true, extractionStatus: true },
  });
  if (!doc || !isPricedDocumentType(doc.documentType)) return;
  // Don't spend again on something already read, in flight, or that this
  // pipeline can't read at all.
  if (doc.extractionStatus !== "PENDING") return;

  try {
    await analyzeDocument(opportunityId, documentId, userId);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) return;
    console.error(`[documents] auto-analysis failed for ${documentId}`, err);
  }
}

// Compares a drawing against the drawing it replaces -- the only
// comparison that works on a rendering package, and the one that can
// name a reception counter when a schedule diff cannot. Explicit rather
// than automatic: it is a vision request over both documents' pages, so
// it runs when somebody asks the question.
//
// Returns its refusal rather than throwing -- every way this declines
// (not a drawing, replaces nothing, nothing readable) is something the
// person can act on, and Next.js redacts thrown Server Action errors in
// production.
export async function compareDrawingRevisionAction(
  opportunityId: string,
  documentId: string,
  _prev: ActionResult,
): Promise<ActionResult> {
  return catchUserError(async () => {
    const user = await requireOpportunityAccess(opportunityId);
    try {
      await compareDrawingToPredecessor(opportunityId, documentId, user.id);
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        throw new UserError("AI features aren't configured yet -- add OPENAI_API_KEY to enable drawing comparison.");
      }
      throw err;
    }
    revalidatePath(`/opportunities/${opportunityId}`);
  });
}
