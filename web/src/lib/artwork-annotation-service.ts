// Pinned-point comments on a rasterized artwork proof/approved-artwork
// image -- see ArtworkAnnotation's own schema comment for the full design
// rationale (only CLIENT/EXPO ever create one, only EXPO resolves, and the
// vendor-facing read path structurally omits author fields rather than
// just hiding them in the UI).
import { db } from "@/lib/db";
import type { ArtworkActor } from "@/lib/artwork-order-service";

export async function createAnnotation(
  artworkFileId: string,
  data: { xPct: number; yPct: number; note: string },
  actor: ArtworkActor,
) {
  if (data.xPct < 0 || data.xPct > 1 || data.yPct < 0 || data.yPct > 1) {
    throw new Error("Pin position must be within the image.");
  }
  const note = data.note.trim();
  if (!note) throw new Error("A note is required for a pinned comment.");

  return db.artworkAnnotation.create({
    data: {
      artworkFileId,
      xPct: data.xPct,
      yPct: data.yPct,
      note,
      authorType: actor.type,
      authorUserId: actor.userId ?? null,
      authorEmail: actor.email ?? null,
    },
  });
}

// Always an Expo user (enforced by every call site's own access check, not
// re-checked here) -- see ArtworkAnnotation's own comment for why no
// separate resolution note is collected.
export async function resolveAnnotation(annotationId: string, resolvedByUserId: string) {
  return db.artworkAnnotation.update({
    where: { id: annotationId },
    data: { resolvedAt: new Date(), resolvedByUserId },
  });
}

export interface ViewerAnnotation {
  id: string;
  xPct: number;
  yPct: number;
  note: string;
  resolvedAt: Date | null;
  createdAt: Date;
  authorType?: "CLIENT" | "EXPO";
}

// anonymize:true (the vendor path) omits authorType/authorUserId/
// authorEmail from the Prisma `select` itself -- the same structural
// enforcement already used for the vendor's existing review-note query
// (vendor-portal/[token]/page.tsx's latestReviewNote) -- rather than
// fetching everything and hiding the field only in the UI, where a future
// change to the viewer could leak it.
export async function listAnnotationsForViewer(
  artworkFileId: string,
  opts: { anonymize: boolean },
): Promise<ViewerAnnotation[]> {
  if (opts.anonymize) {
    return db.artworkAnnotation.findMany({
      where: { artworkFileId },
      orderBy: { createdAt: "asc" },
      select: { id: true, xPct: true, yPct: true, note: true, resolvedAt: true, createdAt: true },
    });
  }
  const rows = await db.artworkAnnotation.findMany({
    where: { artworkFileId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      xPct: true,
      yPct: true,
      note: true,
      resolvedAt: true,
      createdAt: true,
      authorType: true,
    },
  });
  return rows.map((r) => ({ ...r, authorType: r.authorType as "CLIENT" | "EXPO" }));
}
