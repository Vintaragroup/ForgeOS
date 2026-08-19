// Framework-agnostic document ingestion, kept separate from any
// app/opportunities/documents/actions.ts the same way estimate-service.ts
// is kept separate from app/estimates/actions.ts (see that file's header
// comment). Phase 7: data/RFP/superbowl's two real RFP packages are this
// feature's roadmap.

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { DocumentType } from "@/generated/prisma/enums";
import { buildStorageKey, deleteObject, getObject, headPrivateObject, putObject } from "@/lib/storage";

// Exported: documents/upload/route.ts's onBeforeGenerateToken enforces the
// same two rules (extension, size) before it ever issues a client upload
// token, for the direct-to-Blob path -- see that file's header comment for
// why the check has to happen there too, not just here.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB -- see next.config.ts's bodySizeLimit comment

// Native CAD/BIM formats aren't parseable without a heavy proprietary
// SDK -- out of scope by design (see Phase 7 plan). Real-world CAD content
// arrives as a PDF/image export in practice (confirmed against both real
// RFP packages in data/RFP/superbowl), which this app CAN read. Rejecting
// these extensions up front gives a clear message instead of silently
// storing a file nothing will ever extract text or a summary from.
export const UNSUPPORTED_EXTENSIONS = [".dwg", ".dxf", ".rvt", ".skp"];

export async function uploadDocument(
  opportunityId: string,
  data: { file: File; documentType: DocumentType; uploadedById?: string | null },
) {
  if (data.file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB upload limit.`);
  }

  const lowerName = data.file.name.toLowerCase();
  if (UNSUPPORTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    throw new Error(
      `Native CAD files (${UNSUPPORTED_EXTENSIONS.join(", ")}) can't be read by this app. Upload a PDF or image export of the drawing instead.`,
    );
  }

  const bytes = Buffer.from(await data.file.arrayBuffer());
  const storageKey = buildStorageKey(opportunityId, data.file.name);
  await putObject(storageKey, bytes);

  return db.document.create({
    data: {
      opportunityId,
      filename: data.file.name,
      mimeType: data.file.type || "application/octet-stream",
      sizeBytes: bytes.byteLength,
      storageKey,
      documentType: data.documentType,
      uploadedById: data.uploadedById ?? null,
    },
  });
}

// Counterpart to uploadDocument for the direct-to-Blob path (documents/
// upload/route.ts + document-upload-form.tsx): the file's bytes already
// live in Blob by the time this runs -- the browser uploaded them straight
// there, never through this server at all, which is the whole point (see
// next.config.ts's bodySizeLimit comment on why routing large files through
// a Server Action's own body doesn't scale). This only needs to verify the
// blob and record it, mirroring uploadDocument's db.document.create shape.
// storageKey is trusted here only because documents/upload/route.ts's
// onBeforeGenerateToken already required it to start with
// `${opportunityId}/` before a token was ever issued for it -- re-checked
// here too since this function has its own callers.
export async function finalizeUploadedDocument(
  opportunityId: string,
  data: { storageKey: string; filename: string; documentType: DocumentType; uploadedById?: string | null },
) {
  if (!data.storageKey.startsWith(`${opportunityId}/`)) {
    throw new Error("Storage key doesn't belong to this opportunity.");
  }

  const { size, contentType } = await headPrivateObject(data.storageKey);

  return db.document.create({
    data: {
      opportunityId,
      filename: data.filename,
      mimeType: contentType || "application/octet-stream",
      sizeBytes: size,
      storageKey: data.storageKey,
      documentType: data.documentType,
      uploadedById: data.uploadedById ?? null,
    },
  });
}

export async function listDocuments(opportunityId: string) {
  return db.document.findMany({
    where: { opportunityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { uploadedBy: { select: { name: true } } },
  });
}

// Row only, no storage read -- for callers (the /view page's PDF branch)
// that only need filename/mimeType and hand the byte-serving off to the
// raw-bytes route instead of loading a possibly-large file into memory
// just to discard it.
export async function getDocument(documentId: string) {
  return db.document.findFirstOrThrow({ where: { id: documentId, deletedAt: null } });
}

export async function getDocumentBytes(documentId: string) {
  const document = await db.document.findFirstOrThrow({ where: { id: documentId, deletedAt: null } });
  const bytes = await getObject(document.storageKey);
  return { document, bytes };
}

// Soft-delete only, mirroring Attachment -- the on-disk bytes are removed
// immediately (there's no benefit to keeping them once the record is
// gone, unlike the DB row which stays for audit/history purposes).
//
// opportunityId is the caller's already-access-checked opportunity (from
// requireOpportunityAccess), NOT trusted from documentId alone -- see
// [documentId]/route.ts's own header comment for the exact vulnerability
// class this guards against: a documentId is an opaque, guessable/
// enumerable string, and without confirming it actually belongs to the
// opportunity the caller was authorized for, any authenticated user could
// mutate another company's document by ID alone. findFirstOrThrow with
// both id AND opportunityId in the where clause does the ownership check
// and the existence check in one query, the same pattern cut-list's
// addCutListPartAction already uses for a lineItemId.
export async function deleteDocument(opportunityId: string, documentId: string) {
  const existing = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId, deletedAt: null } });
  const document = await db.document.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
  });
  await deleteObject(document.storageKey);
  return document;
}

// A wrong documentType silently sends a file down the wrong pipeline --
// e.g. a Pricing Schedule .xlsx tagged RFP goes through the text
// summarizer instead of the deterministic XLSX parser and comes back
// UNSUPPORTED (see opportunities/[id]/page.tsx's mistagged-spreadsheet
// warning). Whatever was already extracted under the old (wrong)
// assumption is reset back to PENDING rather than left stale, so the
// document reads as "needs analysis again," not as already analyzed
// under the type it's about to stop being.
// opportunityId ownership check -- see deleteDocument's header comment.
export async function updateDocumentType(opportunityId: string, documentId: string, documentType: DocumentType) {
  const existing = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId, deletedAt: null } });
  return db.document.update({
    where: { id: existing.id },
    data: {
      documentType,
      extractionStatus: "PENDING",
      extractedText: null,
      extractedSummary: Prisma.DbNull,
      proposedLineItems: Prisma.DbNull,
    },
  });
}

// Same reset posture as updateDocumentType above -- whatever was already
// extracted was classified (or not) under the OLD estimate assignment,
// so it's stale the moment that assignment changes, not just cosmetically
// out of date. estimateId null clears a manual tag, reverting the
// document back to AI classification at fact level (see document-
// summary-service.ts's own estimateId resolution).
// opportunityId ownership check -- see deleteDocument's header comment.
export async function assignDocumentEstimate(opportunityId: string, documentId: string, estimateId: string | null) {
  const existing = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId, deletedAt: null } });
  return db.document.update({
    where: { id: existing.id },
    data: {
      estimateId,
      extractionStatus: "PENDING",
      extractedText: null,
      extractedSummary: Prisma.DbNull,
      proposedLineItems: Prisma.DbNull,
    },
  });
}
