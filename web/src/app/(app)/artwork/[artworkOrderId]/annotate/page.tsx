// Pinned-point comments on a rasterized proof/approved-artwork image --
// same "real page, not a raw image route" shape as proof-diff/page.tsx,
// reusing the exact same server-side rasterization (renderPdfPageToPng)
// rather than a new route.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrder } from "@/lib/opportunity-access";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";
import { renderPdfPageToPng } from "@/lib/document-view-service";
import { listAnnotationsForViewer } from "@/lib/artwork-annotation-service";
import { Card, PageHeader } from "@/components/ui";
import { ArtworkAnnotationViewer } from "@/components/artwork-annotation-viewer";
import { createAnnotationAction, resolveAnnotationAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function AnnotatePage({
  params,
  searchParams,
}: {
  params: Promise<{ artworkOrderId: string }>;
  searchParams: Promise<{ fileId?: string }>;
}) {
  const { artworkOrderId } = await params;
  const { fileId } = await searchParams;
  const user = await getCurrentUser();
  if (!user) notFound();

  const order = await db.artworkOrder.findUnique({ where: { id: artworkOrderId, deletedAt: null } });
  if (!order) notFound();
  if (!(await canAccessArtworkOrder(user, order.opportunityId))) notFound();
  if (!fileId) notFound();

  // Independently verify fileId belongs to THIS order, never trust the
  // query string alone -- same posture as client-portal's own
  // files/[fileId]/route.ts.
  let file, bytes;
  try {
    ({ file, bytes } = await getArtworkFileBytes(fileId));
  } catch {
    notFound();
  }
  if (file.artworkOrderId !== artworkOrderId) notFound();

  const imageDataUrl = await renderPdfPageToPng(bytes, 1);
  const annotations = await listAnnotationsForViewer(fileId, { anonymize: false });

  return (
    <>
      <PageHeader title={`${order.jobCode} — ${file.filename}`} backHref={`/artwork/${order.id}`} backLabel="Order" />
      <Card className="p-6">
        {!imageDataUrl ? (
          <p className="text-sm text-neutral-600">This file couldn&apos;t be rendered as an image.</p>
        ) : (
          <ArtworkAnnotationViewer
            imageDataUrl={imageDataUrl}
            annotations={annotations}
            canCreate
            canResolve
            anonymized={false}
            artworkFileId={fileId}
            createAction={createAnnotationAction.bind(null, artworkOrderId)}
            resolveAction={resolveAnnotationAction.bind(null, artworkOrderId)}
          />
        )}
      </Card>
    </>
  );
}
