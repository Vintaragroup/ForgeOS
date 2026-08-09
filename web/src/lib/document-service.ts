// Framework-agnostic document ingestion, kept separate from any
// app/opportunities/documents/actions.ts the same way estimate-service.ts
// is kept separate from app/estimates/actions.ts (see that file's header
// comment). Phase 7: data/RFP/superbowl's two real RFP packages are this
// feature's roadmap.

import { db } from "@/lib/db";
import type { DocumentType } from "@/generated/prisma/enums";
import { buildStorageKey, deleteObject, getObject, putObject } from "@/lib/storage";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB -- see next.config.ts's bodySizeLimit comment

// Native CAD/BIM formats aren't parseable without a heavy proprietary
// SDK -- out of scope by design (see Phase 7 plan). Real-world CAD content
// arrives as a PDF/image export in practice (confirmed against both real
// RFP packages in data/RFP/superbowl), which this app CAN read. Rejecting
// these extensions up front gives a clear message instead of silently
// storing a file nothing will ever extract text or a summary from.
const UNSUPPORTED_EXTENSIONS = [".dwg", ".dxf", ".rvt", ".skp"];

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

export async function listDocuments(opportunityId: string) {
  return db.document.findMany({
    where: { opportunityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { uploadedBy: { select: { name: true } } },
  });
}

export async function getDocumentBytes(documentId: string) {
  const document = await db.document.findFirstOrThrow({ where: { id: documentId, deletedAt: null } });
  const bytes = await getObject(document.storageKey);
  return { document, bytes };
}

// Soft-delete only, mirroring Attachment -- the on-disk bytes are removed
// immediately (there's no benefit to keeping them once the record is
// gone, unlike the DB row which stays for audit/history purposes).
export async function deleteDocument(documentId: string) {
  const document = await db.document.update({
    where: { id: documentId },
    data: { deletedAt: new Date() },
  });
  await deleteObject(document.storageKey);
  return document;
}
