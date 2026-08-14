// Cut-list phase 3: downloads the cutting diagram for one material's
// current nesting result. Rendered fresh from the stored CutSheet rows
// on every request (see cut-sheet-pdf.tsx's own header comment for why
// this isn't pre-generated and stored) -- same GET-route-renders-live
// shape as the existing proposal preview-pdf route this mirrors.
import { notFound } from "next/navigation";
import { renderToBuffer } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { getCutSheetDiagramData } from "@/lib/cut-list-nesting-service";
import { CutSheetDiagramDocument } from "@/lib/cut-sheet-pdf";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/estimates/[id]/versions/[versionId]/cut-list/[materialId]/diagram">,
) {
  const { id, versionId, materialId } = await params;

  const user = await getCurrentUser();
  if (!user) notFound();

  const version = await db.estimateVersion.findFirst({
    where: { id: versionId, estimateId: id },
    include: { estimate: { select: { opportunityId: true } } },
  });
  if (!version) notFound();
  if (!(await canAccessOpportunity(user, version.estimate.opportunityId))) notFound();

  let data;
  try {
    data = await getCutSheetDiagramData(versionId, materialId);
  } catch {
    // No CutSheet rows yet for this material (never optimized, or since
    // deleted) -- a 404 is more honest than a 500 for "this doesn't
    // exist yet," same as every other not-found case in this route.
    notFound();
  }

  const buffer = await renderToBuffer(CutSheetDiagramDocument({ data }));

  const filename = `cutting-diagram-${data.materialName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
