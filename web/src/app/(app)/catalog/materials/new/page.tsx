import { createMaterial } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

const MATERIAL_TYPE_OPTIONS = [
  { value: "", label: "— not cuttable stock —" },
  { value: "SHEET", label: "Sheet (nestable -- plywood, MDF, acrylic, ...)" },
  { value: "LINEAR", label: "Linear (cut to length -- dimensioned lumber, tube, ...)" },
];

export default function NewMaterialPage() {
  return (
    <div>
      <PageHeader title="New material" backHref="/catalog/materials" backLabel="Materials" />
      <Card className="p-6">
        <form action={createMaterial} className="flex flex-col gap-4">
          <Field label="Material name" name="name" required />
          <Field label="Unit" name="unit" placeholder="e.g. sq ft, sheet, ea" />
          <Field label="Category" name="category" placeholder="e.g. Lumber, Hardware" />
          <Field label="Current unit cost ($)" name="currentUnitCost" type="number" required />
          <Field
            label="Source note"
            name="sourceNote"
            placeholder="Where this price came from -- a real job, a supplier quote, an estimate"
          />

          <div className="border-t border-neutral-200 pt-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Cut-list stock setup
            </h2>
            <p className="mb-4 text-sm text-neutral-500">
              Only needed if this material is actually cut from raw stock -- leave blank for hardware, adhesives,
              and anything else that isn&apos;t cuttable stock.
            </p>
            <div className="flex flex-col gap-4">
              <SelectField label="Material type" name="materialType" options={MATERIAL_TYPE_OPTIONS} />
              <div className="grid grid-cols-2 gap-4">
                <Field label="Stock width (in)" name="stockWidth" type="number" placeholder="e.g. 48 -- sheet goods only" />
                <Field label="Stock length (in)" name="stockLength" type="number" placeholder="e.g. 96" />
                <Field label="Thickness (in)" name="thickness" type="number" placeholder="e.g. 0.75" />
                <Field label="Default kerf (in)" name="defaultKerf" type="number" placeholder="e.g. 0.125" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="grainDirectionMatters" />
                Grain direction matters -- parts cut from this material can&apos;t be freely rotated when nesting
              </label>
            </div>
          </div>

          <div>
            <Button>Create material</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
