import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteMaterial, updateMaterial } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

const MATERIAL_TYPE_OPTIONS = [
  { value: "", label: "— not cuttable stock —" },
  { value: "SHEET", label: "Sheet (nestable -- plywood, MDF, acrylic, ...)" },
  { value: "LINEAR", label: "Linear (cut to length -- dimensioned lumber, tube, ...)" },
];

export default async function MaterialDetailPage(props: PageProps<"/catalog/materials/[id]">) {
  const { id } = await props.params;
  const material = await db.material.findFirst({ where: { id, deletedAt: null } });
  if (!material) notFound();

  const updateMaterialWithId = updateMaterial.bind(null, material.id);
  const deleteMaterialWithId = deleteMaterial.bind(null, material.id);

  return (
    <div>
      <PageHeader title={material.name} backHref="/catalog/materials" backLabel="Materials" />
      <Card className="p-6">
        <form action={updateMaterialWithId} className="flex flex-col gap-4">
          <Field label="Material name" name="name" defaultValue={material.name} required />
          <Field label="Unit" name="unit" defaultValue={material.unit ?? ""} placeholder="e.g. sq ft, sheet, ea" />
          <Field
            label="Category"
            name="category"
            defaultValue={material.category ?? ""}
            placeholder="e.g. Lumber, Hardware"
          />
          <Field
            label="Current unit cost ($)"
            name="currentUnitCost"
            type="number"
            defaultValue={material.currentUnitCost.toString()}
            required
          />
          <Field
            label="Source note"
            name="sourceNote"
            defaultValue={material.sourceNote ?? ""}
            placeholder="Where this price came from -- a real job, a supplier quote, an estimate"
          />

          <div className="border-t border-neutral-200 pt-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Cut-list stock setup
            </h2>
            <p className="mb-4 text-sm text-neutral-500">
              Only needed if this material is actually cut from raw stock -- the cut-list feature (nesting,
              cutting diagrams, DXF export) only works for a material with a type and stock dimensions set here.
              Leave blank for hardware, adhesives, and anything else that isn&apos;t cuttable stock.
            </p>
            <div className="flex flex-col gap-4">
              <SelectField
                label="Material type"
                name="materialType"
                defaultValue={material.materialType ?? ""}
                options={MATERIAL_TYPE_OPTIONS}
              />
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Stock width (in)"
                  name="stockWidth"
                  type="number"
                  defaultValue={material.stockWidth?.toString() ?? ""}
                  placeholder="e.g. 48 -- sheet goods only"
                />
                <Field
                  label="Stock length (in)"
                  name="stockLength"
                  type="number"
                  defaultValue={material.stockLength?.toString() ?? ""}
                  placeholder="e.g. 96"
                />
                <Field
                  label="Thickness (in)"
                  name="thickness"
                  type="number"
                  defaultValue={material.thickness?.toString() ?? ""}
                  placeholder="e.g. 0.75"
                />
                <Field
                  label="Default kerf (in)"
                  name="defaultKerf"
                  type="number"
                  defaultValue={material.defaultKerf?.toString() ?? ""}
                  placeholder="e.g. 0.125"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="grainDirectionMatters"
                  defaultChecked={material.grainDirectionMatters}
                />
                Grain direction matters -- parts cut from this material can&apos;t be freely rotated when nesting
              </label>
            </div>
          </div>

          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteMaterialWithId}
          confirmMessage="Delete this material? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete material</Button>
        </ConfirmForm>
      </Card>
    </div>
  );
}
