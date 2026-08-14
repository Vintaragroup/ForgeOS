import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { getCutListCostReport, getCutSheetDiagramData, type OptimizeAllResult } from "@/lib/cut-list-nesting-service";
import { getCutListSettings } from "@/lib/cut-list-settings-service";
import { addCutListPartAction, deleteCutListPartAction, optimizeAllMaterialsAction, optimizeMaterialAction } from "./actions";
import { Button, Card, CollapsibleSection, Field, Notice, PageHeader, SelectField } from "@/components/ui";
import { CutListPartFields } from "@/components/cut-list-part-fields";
import { CutSheetDiagram } from "@/components/cut-sheet-diagram";
import { CutSheetDiagramEditor } from "@/components/cut-sheet-diagram-editor";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function CutListPage(props: PageProps<"/estimates/[id]/versions/[versionId]/cut-list">) {
  const { id, versionId } = await props.params;
  const { optimizeError: optimizeErrorParam, optimizeAllResult: optimizeAllResultParam } = await props.searchParams;
  const optimizeError = Array.isArray(optimizeErrorParam) ? optimizeErrorParam[0] : optimizeErrorParam;
  const optimizeAllResultRaw = Array.isArray(optimizeAllResultParam) ? optimizeAllResultParam[0] : optimizeAllResultParam;
  let optimizeAllResult: OptimizeAllResult | null = null;
  if (optimizeAllResultRaw) {
    try {
      optimizeAllResult = JSON.parse(optimizeAllResultRaw) as OptimizeAllResult;
    } catch {
      optimizeAllResult = null; // malformed/tampered query param -- ignore rather than crash the page
    }
  }

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const version = await db.estimateVersion.findFirst({
    where: { id: versionId, estimateId: id },
    include: { estimate: { include: { opportunity: { select: { id: true, showName: true } } } } },
  });
  if (!version) notFound();
  if (!(await canAccessOpportunity(user, version.estimate.opportunityId))) notFound();

  const [cutListParts, sheetMaterials, lineItems, costReport, settings] = await Promise.all([
    db.cutListPart.findMany({
      where: { estimateVersionId: versionId, deletedAt: null },
      include: { material: true, lineItem: true },
      orderBy: { createdAt: "asc" },
    }),
    // Only materials actually set up as nestable stock (see the Cut-list
    // stock setup section on a Material's catalog page) are valid targets
    // for a new part -- an empty list here means nothing's been set up
    // yet, not that the catalog itself is empty.
    db.material.findMany({
      where: { deletedAt: null, materialType: "SHEET", stockWidth: { not: null }, stockLength: { not: null } },
      orderBy: { name: "asc" },
    }),
    // LineItem has no direct estimateVersionId -- always reached through
    // its EstimateSection. Offered as an optional "link to line item"
    // pick on Add-a-part (cut-list-part-fields.tsx) so a part can be tied
    // back to the priced line it's fabrication detail for, instead of
    // living as a disconnected shadow list.
    db.lineItem.findMany({
      where: { section: { estimateVersionId: versionId } },
      orderBy: [{ category: "asc" }, { description: "asc" }],
    }),
    getCutListCostReport(versionId),
    getCutListSettings(),
  ]);

  const lineItemOptions = lineItems.map((li) => ({
    id: li.id,
    label: li.category ? `${li.category} — ${li.description}` : li.description,
    description: li.description,
  }));

  const wasteByMaterialId = new Map(costReport.materials.map((m) => [m.materialId, m]));

  const partsByMaterial = new Map<string, typeof cutListParts>();
  for (const part of cutListParts) {
    const list = partsByMaterial.get(part.materialId) ?? [];
    list.push(part);
    partsByMaterial.set(part.materialId, list);
  }
  const materialGroups = [...partsByMaterial.entries()]
    .map(([materialId, parts]) => ({ materialId, material: parts[0].material, parts }))
    .sort((a, b) => a.material.name.localeCompare(b.material.name));

  // Only for materials that have actually been optimized (real CutSheet
  // rows to read) -- fetched in parallel (not a sequential per-material
  // await) once materialGroups is known, since it's derived from
  // cutListParts above. Renders the packed layout inline (Feature 4) in
  // addition to the existing PDF/DXF download links, which stay useful
  // for printing and CNC.
  const diagramEntries = await Promise.all(
    materialGroups
      .filter(({ materialId }) => wasteByMaterialId.has(materialId))
      .map(async ({ materialId }) => [materialId, await getCutSheetDiagramData(versionId, materialId)] as const),
  );
  const diagramDataByMaterialId = new Map(diagramEntries);

  const addPartWithIds = addCutListPartAction.bind(null, id, versionId);
  const optimizeAllWithIds = optimizeAllMaterialsAction.bind(null, id, versionId);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Cut list — ${version.estimate.opportunity.showName}`}
        action={
          <Link href={`/estimates/${id}`} className="text-sm text-neutral-500 hover:text-neutral-900">
            ← Back to estimate
          </Link>
        }
      />

      <p className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Version {version.versionNumber} {version.isLocked ? "· locked" : "· editing"}
      </p>

      {optimizeError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{optimizeError}</div>
      )}

      {optimizeAllResult && (
        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Optimize results</h2>
          {optimizeAllResult.optimized.length > 0 && (
            <div className="mb-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm">
              <p className="mb-1 font-medium text-green-900">Optimized {optimizeAllResult.optimized.length} material(s):</p>
              <ul className="flex flex-col gap-0.5 text-green-800">
                {optimizeAllResult.optimized.map((r, i) => (
                  <li key={i}>
                    {r.materialName} — {r.sheetCount} sheet{r.sheetCount === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {optimizeAllResult.skipped.length > 0 && (
            <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
              <p className="mb-1 font-medium text-neutral-700">Skipped {optimizeAllResult.skipped.length} material(s):</p>
              <ul className="flex flex-col gap-0.5 text-neutral-600">
                {optimizeAllResult.skipped.map((r, i) => (
                  <li key={i}>
                    {r.materialName} — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {costReport.materials.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Cut list summary</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-400">Total material cost</div>
              <div className="text-lg font-semibold">{money(costReport.totalCost)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-400">Total sheets</div>
              <div className="text-lg font-semibold">{costReport.totalSheetsUsed}</div>
            </div>
          </div>
        </Card>
      )}

      {!version.isLocked && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Add a part</h2>
          <p className="mb-4 text-sm text-neutral-500">
            Every dimension is in inches. Only materials set up as nestable sheet stock (material type + stock
            width/length, on that material&apos;s own catalog page) appear below.
          </p>
          {sheetMaterials.length === 0 ? (
            <Notice
              message="No materials are set up as cuttable sheet stock yet."
              actionHref="/catalog/materials"
              actionLabel="Set one up"
            />
          ) : (
            <form action={addPartWithIds} className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
              <CutListPartFields lineItems={lineItemOptions} />
              <div className="col-span-2 sm:order-2 sm:w-56">
                <SelectField
                  label="Material"
                  name="materialId"
                  required
                  options={sheetMaterials.map((m) => ({
                    value: m.id,
                    label: `${m.name} (${m.stockWidth}x${m.stockLength})`,
                  }))}
                />
              </div>
              <div className="sm:order-3 sm:w-24">
                <Field label="Width (in)" name="width" type="number" required />
              </div>
              <div className="sm:order-4 sm:w-24">
                <Field label="Length (in)" name="length" type="number" required />
              </div>
              <div className="sm:order-5 sm:w-20">
                <Field label="Qty" name="qty" type="number" defaultValue="1" required />
              </div>
              <label className="col-span-2 flex items-center gap-1.5 pb-2 text-sm text-neutral-700 sm:order-6 sm:col-span-1">
                <input type="checkbox" name="grainConstrained" />
                Grain-constrained
              </label>
              <div className="col-span-2 sm:order-7">
                <Button variant="secondary">Add part</Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {materialGroups.length > 0 && !version.isLocked && (
        <form action={optimizeAllWithIds}>
          <Button>Optimize all materials</Button>
        </form>
      )}

      {materialGroups.map(({ materialId, material, parts }) => {
        const waste = wasteByMaterialId.get(materialId);
        const diagramData = diagramDataByMaterialId.get(materialId);
        const optimizeWithIds = optimizeMaterialAction.bind(null, id, versionId, materialId);
        const deleteWithIds = deleteCutListPartAction.bind(null, id, versionId);
        return (
          <CollapsibleSection key={materialId} title={`${material.name} (${parts.length} part${parts.length === 1 ? "" : "s"})`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-neutral-500">
                Stock: {material.stockWidth?.toString()}x{material.stockLength?.toString()}
                {material.thickness ? ` x ${material.thickness}"` : ""}
                {material.defaultKerf ? ` — kerf ${material.defaultKerf}"` : ""}
              </div>
              {!version.isLocked && (
                <form action={optimizeWithIds}>
                  <Button variant="secondary">{waste ? "Re-optimize" : "Optimize"}</Button>
                </form>
              )}
            </div>

            {waste && (
              <div className="mb-4 flex flex-wrap items-center gap-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
                <span>
                  <strong>{waste.sheetsUsed}</strong> sheet{waste.sheetsUsed === 1 ? "" : "s"}
                  {waste.remnantSheetsUsed > 0 && (
                    <span className="text-neutral-500">
                      {" "}
                      ({waste.remnantSheetsUsed} remnant, {waste.freshSheetsUsed} fresh)
                    </span>
                  )}
                </span>
                <span>
                  <strong>{money(waste.totalCost)}</strong> material cost
                </span>
                <span>
                  <strong>{(waste.wastePct * 100).toFixed(1)}%</strong> waste
                </span>
                <Link
                  href={`/estimates/${id}/versions/${versionId}/cut-list/${materialId}/diagram`}
                  target="_blank"
                  className="text-brand-navy hover:underline"
                >
                  View diagram (PDF)
                </Link>
                <span className="flex flex-wrap gap-2">
                  {Array.from({ length: waste.sheetsUsed }, (_, i) => i + 1).map((sheetNum) => (
                    <a
                      key={sheetNum}
                      href={`/estimates/${id}/versions/${versionId}/cut-list/${materialId}/sheets/${sheetNum}/dxf`}
                      className="text-brand-navy hover:underline"
                    >
                      Sheet {sheetNum} DXF
                    </a>
                  ))}
                </span>
              </div>
            )}

            {diagramData && (
              <div className="mb-4 flex flex-col gap-4">
                {diagramData.sheets.map((sheet) =>
                  version.isLocked ? (
                    <CutSheetDiagram key={sheet.sheetNumber} sheet={sheet} sheetCount={diagramData.sheets.length} />
                  ) : (
                    <CutSheetDiagramEditor
                      key={sheet.sheetNumber}
                      estimateId={id}
                      versionId={versionId}
                      materialId={materialId}
                      sheet={sheet}
                      sheetCount={diagramData.sheets.length}
                      gridSnap={settings.dragGridSnap.toNumber()}
                    />
                  ),
                )}
              </div>
            )}

            <ul className="flex flex-col divide-y divide-neutral-200 text-sm">
              {parts.map((part) => (
                <li key={part.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    {part.description} — {part.width?.toString()}x{part.length.toString()} x{part.qty}
                    {part.grainConstrained && <span className="ml-1 text-amber-600">(grain-constrained)</span>}
                    {part.lineItem && (
                      <span className="ml-1 text-neutral-400">— linked to &quot;{part.lineItem.description}&quot;</span>
                    )}
                  </span>
                  {!version.isLocked && (
                    <form action={deleteWithIds.bind(null, part.id)}>
                      <button type="submit" className="text-neutral-400 hover:text-red-600" aria-label={`Delete ${part.description}`}>
                        ✕
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        );
      })}
    </div>
  );
}
