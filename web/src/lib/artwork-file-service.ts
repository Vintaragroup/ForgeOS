// File handling shared by all three artwork-pipeline surfaces (Expo
// internal pages, Client Portal, Vendor Portal). Reuses storage.ts's
// existing putObject/getObject exactly as documents already do -- the only
// new concern here is anonymity: filename is ALWAYS system-assigned (e.g.
// "proof-round-1.pdf"), never the uploader's own original filename, since
// an uploader's filename could itself leak identifying info (a vendor's
// company name, a client's internal naming convention) to the other party.
// See ArtworkFile's schema comment for the full rationale.
import path from "node:path";
import { db } from "@/lib/db";
import { getObject } from "@/lib/storage";
import type { ArtworkActorType, ArtworkFileKind } from "@/generated/prisma/enums";

function systemAssignedFilename(kind: ArtworkFileKind, round: number, originalFilename: string): string {
  const ext = path.extname(originalFilename).toLowerCase() || ".pdf";
  return kind === "PROOF" ? `proof-round-${round}${ext}` : `artwork${ext}`;
}

export async function finalizeArtworkUpload(
  artworkOrderId: string,
  data: {
    storageKey: string;
    kind: ArtworkFileKind;
    round: number;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    uploadedByType: ArtworkActorType;
    uploadedByUserId?: string | null;
    uploadedByEmail?: string | null;
  },
) {
  return db.artworkFile.create({
    data: {
      artworkOrderId,
      kind: data.kind,
      round: data.round,
      filename: systemAssignedFilename(data.kind, data.round, data.originalFilename),
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
      storageKey: data.storageKey,
      uploadedByType: data.uploadedByType,
      uploadedByUserId: data.uploadedByUserId ?? null,
      uploadedByEmail: data.uploadedByEmail ?? null,
    },
  });
}

export async function getArtworkFileBytes(fileId: string) {
  const file = await db.artworkFile.findUniqueOrThrow({ where: { id: fileId, deletedAt: null } });
  const bytes = await getObject(file.storageKey);
  return { file, bytes };
}

// Only PDF and AI (Illustrator) accepted per the client-facing wireframe
// (Section 6.3: "Accepted: PDF, AI") -- an allowlist, not the Document
// model's extension BLOCKlist, since this upload surface's accepted set is
// much narrower than general document intake.
export const ARTWORK_UPLOAD_EXTENSIONS = [".pdf", ".ai"];
export const MAX_ARTWORK_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB, per the same wireframe
