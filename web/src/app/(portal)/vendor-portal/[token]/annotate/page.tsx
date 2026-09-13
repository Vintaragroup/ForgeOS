// View-only counterpart to the internal/client annotate pages -- the
// vendor never creates or resolves a pin, and listAnnotationsForViewer is
// called with anonymize:true so authorType/authorUserId/authorEmail are
// never even fetched, not just hidden in the UI (see that function's own
// comment). No opportunity/company/contact relation is fetched here either,
// same instinct as the rest of this page's own vendor-anonymity posture.
import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePortalAccess } from "@/lib/artwork-portal-auth";
import { db } from "@/lib/db";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";
import { renderPdfPageToPng } from "@/lib/document-view-service";
import { listAnnotationsForViewer } from "@/lib/artwork-annotation-service";
import { Card } from "@/components/ui";
import { ArtworkAnnotationViewer } from "@/components/artwork-annotation-viewer";

export const dynamic = "force-dynamic";

export default async function VendorAnnotatePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ fileId?: string }>;
}) {
  const { token } = await params;
  const { fileId } = await searchParams;
  if (!fileId) notFound();

  let file, bytes;
  try {
    ({ file, bytes } = await getArtworkFileBytes(fileId));
  } catch {
    notFound();
  }
  try {
    await requirePortalAccess(token, { artworkOrderId: file.artworkOrderId, role: "VENDOR" });
  } catch {
    notFound();
  }

  const order = await db.artworkOrder.findUniqueOrThrow({
    where: { id: file.artworkOrderId },
    select: { jobCode: true },
  });
  const imageDataUrl = await renderPdfPageToPng(bytes, 1);
  const annotations = await listAnnotationsForViewer(fileId, { anonymize: true });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/vendor-portal/${token}`} className="text-sm text-neutral-500 hover:underline">
          ← Back
        </Link>
        <h1 className="font-display text-2xl tracking-wide">Job {order.jobCode}</h1>
      </div>
      <Card className="p-6">
        {!imageDataUrl ? (
          <p className="text-sm text-neutral-600">This file couldn&apos;t be rendered as an image.</p>
        ) : (
          <ArtworkAnnotationViewer
            imageDataUrl={imageDataUrl}
            annotations={annotations}
            canCreate={false}
            canResolve={false}
            anonymized
            artworkFileId={fileId}
          />
        )}
      </Card>
    </div>
  );
}
