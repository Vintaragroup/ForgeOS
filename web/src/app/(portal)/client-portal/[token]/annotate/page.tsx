// Client-facing counterpart to the internal annotate page -- same
// rasterize-server-side-render-a-data-URL shape, gated by requirePortalAccess
// instead of canAccessArtworkOrder. The client can pin a note but never
// resolve one (only Expo does) -- see this feature's own plan for why.
import { notFound } from "next/navigation";
import { requirePortalAccess } from "@/lib/artwork-portal-auth";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";
import { renderPdfPageToPng } from "@/lib/document-view-service";
import { listAnnotationsForViewer } from "@/lib/artwork-annotation-service";
import Link from "next/link";
import { Card } from "@/components/ui";
import { ArtworkAnnotationViewer } from "@/components/artwork-annotation-viewer";
import { createAnnotationAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ClientAnnotatePage({
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
    await requirePortalAccess(token, { artworkOrderId: file.artworkOrderId, role: "CLIENT" });
  } catch {
    notFound();
  }

  const imageDataUrl = await renderPdfPageToPng(bytes, 1);
  const annotations = await listAnnotationsForViewer(fileId, { anonymize: false });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/client-portal/${token}`} className="text-sm text-neutral-500 hover:underline">
          ← Back
        </Link>
        <h1 className="font-display text-2xl tracking-wide">{file.filename}</h1>
      </div>
      <Card className="p-6">
        {!imageDataUrl ? (
          <p className="text-sm text-neutral-600">This file couldn&apos;t be rendered as an image.</p>
        ) : (
          <ArtworkAnnotationViewer
            imageDataUrl={imageDataUrl}
            annotations={annotations}
            canCreate
            canResolve={false}
            anonymized={false}
            artworkFileId={fileId}
            createAction={createAnnotationAction.bind(null, token)}
          />
        )}
      </Card>
    </div>
  );
}
