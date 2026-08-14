// Cut-list phase 8: a consolidated whole-version export -- every
// optimized material's placed parts (Cut List sheet) plus the same
// per-material rollup the cut-list page itself shows (Summary sheet), as
// one real .xlsx workbook. This app has only ever READ xlsx via exceljs
// before (xlsx-utils.ts's cellText, pricing-import-service.ts,
// document-view-service.ts) -- this is the first place it WRITES one.
// Same GET-route-renders-live-on-every-request shape as the existing
// per-material PDF diagram/DXF routes right next to this.
import { notFound } from "next/navigation";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { getCutListCostReport, getCutSheetDiagramData } from "@/lib/cut-list-nesting-service";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/estimates/[id]/versions/[versionId]/cut-list/export">,
) {
  const { id, versionId } = await params;

  const user = await getCurrentUser();
  if (!user) notFound();

  const version = await db.estimateVersion.findFirst({
    where: { id: versionId, estimateId: id },
    include: { estimate: { include: { opportunity: { select: { id: true, showName: true } } } } },
  });
  if (!version) notFound();
  if (!(await canAccessOpportunity(user, version.estimate.opportunityId))) notFound();

  const costReport = await getCutListCostReport(versionId);
  if (costReport.materials.length === 0) notFound();

  const diagramDataByMaterial = await Promise.all(
    costReport.materials.map((m) => getCutSheetDiagramData(versionId, m.materialId)),
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ForgeOS";
  workbook.created = new Date();

  const cutListSheet = workbook.addWorksheet("Cut List");
  cutListSheet.columns = [
    { header: "Material", key: "material", width: 30 },
    { header: "Sheet #", key: "sheetNumber", width: 9 },
    { header: "Stock", key: "stock", width: 10 },
    { header: "Part", key: "part", width: 40 },
    { header: "Width (in)", key: "width", width: 12 },
    { header: "Length (in)", key: "length", width: 12 },
    { header: "Rotated", key: "rotated", width: 9 },
    { header: "Cut status", key: "cutStatus", width: 16 },
  ];
  cutListSheet.getRow(1).font = { bold: true };
  for (const data of diagramDataByMaterial) {
    for (const sheet of data.sheets) {
      for (const part of sheet.parts) {
        cutListSheet.addRow({
          material: data.materialName,
          sheetNumber: sheet.sheetNumber,
          stock: sheet.isRemnant ? "Remnant" : "Fresh",
          part: part.description,
          // width/height are the AS-PLACED dimensions (post any rotation)
          // -- same PlacedPart shape every other cut-list consumer
          // (the PDF diagram, the DXF export) reads from.
          width: part.width,
          length: part.height,
          rotated: part.rotated ? "Yes" : "No",
          cutStatus: sheet.cutAt ? `Cut ${new Date(sheet.cutAt).toLocaleDateString()}` : "Not cut",
        });
      }
    }
  }

  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Material", key: "material", width: 30 },
    { header: "Sheets used", key: "sheetsUsed", width: 12 },
    { header: "Fresh", key: "fresh", width: 9 },
    { header: "Remnant", key: "remnant", width: 9 },
    { header: "Cut", key: "cut", width: 9 },
    { header: "Material cost", key: "cost", width: 14 },
    { header: "Waste %", key: "waste", width: 10 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  for (const m of costReport.materials) {
    summarySheet.addRow({
      material: m.materialName,
      sheetsUsed: m.sheetsUsed,
      fresh: m.freshSheetsUsed,
      remnant: m.remnantSheetsUsed,
      cut: m.sheetsCut,
      cost: m.totalCost,
      waste: `${(m.wastePct * 100).toFixed(1)}%`,
    });
  }
  const totalRow = summarySheet.addRow({
    material: "Total",
    sheetsUsed: costReport.totalSheetsUsed,
    cut: costReport.totalSheetsCut,
    cost: costReport.totalCost,
  });
  totalRow.font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `cut-list-${version.estimate.opportunity.showName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
