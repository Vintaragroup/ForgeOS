// Artwork pipeline, proof-sheet piece: streams the ExpoCCI-branded proof
// sheet (artwork-proof-pdf.tsx) for one ArtworkOrder, rendered live on
// every request against current data -- same posture as every other PDF
// route in this app (proposals/[id]/pdf, the cut-list exports, the task
// packet route this one's access-gating mirrors most closely).
//
// Optional ?fileId= lets a caller pin a specific file (e.g. the exact
// proof round being reviewed on the EXPO_PROOF_CHECK card) instead of
// always getting the latest client artwork -- both "View submitted
// artwork" and "View proof" links on the order page point here with a
// different fileId.
import { notFound } from "next/navigation";
import { renderToBuffer } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrder } from "@/lib/opportunity-access";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";
import { renderPdfPageToPng, getPdfPageDimensionsInInches } from "@/lib/document-view-service";
import { buildArtworkProofData, ArtworkProofPdfDocument } from "@/lib/artwork-proof-pdf";

export async function GET(request: Request, { params }: RouteContext<"/artwork/[artworkOrderId]/proof-sheet">) {
  const { artworkOrderId } = await params;
  const fileIdParam = new URL(request.url).searchParams.get("fileId");

  const user = await getCurrentUser();
  if (!user) notFound();

  const order = await db.artworkOrder.findUnique({
    where: { id: artworkOrderId, deletedAt: null },
    include: {
      opportunity: { include: { company: { select: { name: true } }, owner: { select: { name: true } } } },
      sizeTier: { select: { label: true, width: true, height: true } },
      files: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) notFound();
  if (!(await canAccessArtworkOrder(user, order.opportunityId))) notFound();

  const file = fileIdParam
    ? order.files.find((f) => f.id === fileIdParam)
    : order.files.find((f) => f.kind === "CLIENT_ARTWORK");
  if (fileIdParam && !file) notFound();

  let artworkImageDataUrl: string | null = null;
  let previewUnavailable = false;
  let measuredWidthIn: number | null = null;
  let measuredHeightIn: number | null = null;
  if (file) {
    const { bytes } = await getArtworkFileBytes(file.id);
    artworkImageDataUrl = await renderPdfPageToPng(bytes, 1);
    previewUnavailable = artworkImageDataUrl === null;
    const measured = await getPdfPageDimensionsInInches(bytes, 1);
    measuredWidthIn = measured?.widthIn ?? null;
    measuredHeightIn = measured?.heightIn ?? null;
  }

  const data = buildArtworkProofData({
    jobCode: order.jobCode,
    companyName: order.opportunity.company.name,
    showName: order.opportunity.showName,
    boothNumber: order.opportunity.boothNumber,
    date: new Date(),
    revisionRound: order.revisionRound,
    material: order.material,
    qty: order.qty,
    fileName: file?.filename ?? null,
    sizeTierLabel: order.sizeTier?.label ?? null,
    sizeTierWidth: order.sizeTier?.width ? order.sizeTier.width.toNumber() : null,
    sizeTierHeight: order.sizeTier?.height ? order.sizeTier.height.toNumber() : null,
    customWidth: order.customWidth ? order.customWidth.toNumber() : null,
    customHeight: order.customHeight ? order.customHeight.toNumber() : null,
    bleedIn: order.bleedIn ? order.bleedIn.toNumber() : null,
    measuredWidthIn,
    measuredHeightIn,
    ownerName: order.opportunity.owner?.name ?? null,
    artworkImageDataUrl,
    previewUnavailable,
  });

  const buffer = await renderToBuffer(ArtworkProofPdfDocument({ data }));

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="proof-sheet-${order.jobCode}.pdf"`,
    },
  });
}
