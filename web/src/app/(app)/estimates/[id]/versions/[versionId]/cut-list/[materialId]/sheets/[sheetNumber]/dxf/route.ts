// Cut-list phase 3: downloads a DXF file for ONE physical sheet -- see
// cut-sheet-dxf.ts's own header comment for why this is per-sheet rather
// than the PDF diagram's per-material bundle. Same live-render-on-request
// pattern as the diagram route right next to this one.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { generateCutSheetDxf } from "@/lib/cut-sheet-dxf";
import { getCutSheetDiagramData } from "@/lib/cut-list-nesting-service";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/estimates/[id]/versions/[versionId]/cut-list/[materialId]/sheets/[sheetNumber]/dxf">,
) {
  const { id, versionId, materialId, sheetNumber } = await params;
  const sheetNum = Number(sheetNumber);
  if (!Number.isInteger(sheetNum) || sheetNum < 1) return new Response("Invalid sheet number", { status: 400 });

  const user = await getCurrentUser();
  if (!user) notFound();

  const version = await db.estimateVersion.findFirst({
    where: { id: versionId, estimateId: id },
    include: { estimate: { select: { opportunityId: true } } },
  });
  if (!version) notFound();
  if (!(await canAccessOpportunity(user, version.estimate.opportunityId))) notFound();

  let content: string;
  let materialName: string;
  try {
    const data = await getCutSheetDiagramData(versionId, materialId);
    content = generateCutSheetDxf(data, sheetNum);
    materialName = data.materialName;
  } catch {
    notFound();
  }

  const filename = `cutting-sheet-${materialName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${sheetNum}.dxf`;

  return new Response(content, {
    headers: {
      "Content-Type": "application/dxf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
