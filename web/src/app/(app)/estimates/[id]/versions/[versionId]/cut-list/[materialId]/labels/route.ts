// Cut-list phase 9: downloads printable per-part labels for one
// material's current nesting result -- every sheet regardless of locked/
// cut status (a locked/already-cut sheet's parts still need labels for
// the shop floor). Same GET-route-renders-live-on-every-request shape as
// the existing diagram/DXF routes right next to this.
import { notFound } from "next/navigation";
import { renderToBuffer } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { getCutSheetDiagramData } from "@/lib/cut-list-nesting-service";
import { buildCutListLabels, CutListLabelsDocument } from "@/lib/cut-list-labels-pdf";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/estimates/[id]/versions/[versionId]/cut-list/[materialId]/labels">,
) {
  const { id, versionId, materialId } = await params;

  const user = await getCurrentUser();
  if (!user) notFound();

  const version = await db.estimateVersion.findFirst({
    where: { id: versionId, estimateId: id },
    include: { estimate: { include: { opportunity: { select: { id: true, showName: true } } } } },
  });
  if (!version) notFound();
  if (!(await canAccessOpportunity(user, version.estimate.opportunityId))) notFound();

  let data;
  try {
    data = await getCutSheetDiagramData(versionId, materialId);
  } catch {
    notFound();
  }

  const grainRows = await db.cutListPart.findMany({
    where: { estimateVersionId: versionId, materialId },
    select: { id: true, grainConstrained: true },
  });
  const labels = buildCutListLabels(
    version.estimate.opportunity.showName,
    data,
    new Map(grainRows.map((r) => [r.id, r.grainConstrained])),
  );

  const buffer = await renderToBuffer(CutListLabelsDocument({ labels }));

  const filename = `cut-list-labels-${data.materialName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
