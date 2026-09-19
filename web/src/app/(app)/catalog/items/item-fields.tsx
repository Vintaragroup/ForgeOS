import type { CatalogCategory, CatalogItem, CatalogItemType } from "@/generated/prisma/client";
import { Field, SelectField, TextareaField } from "@/components/ui";

const MATERIAL_TYPE_OPTIONS = [
  { value: "", label: "— not cuttable stock —" },
  { value: "SHEET", label: "Sheet (nestable -- plywood, MDF, acrylic, ...)" },
  { value: "LINEAR", label: "Linear (cut to length -- dimensioned lumber, tube, ...)" },
];

export const ITEM_TYPE_LABELS: Record<CatalogItemType, string> = {
  RENTAL: "Rental",
  MATERIAL: "Material",
  SERVICE: "Service",
};

// Shared by /catalog/items/new and /catalog/items/[id]. Item type isn't
// here -- it's picked once on the new page and fixed after that (it's the
// R-/M-/S- prefix of the number; see catalog-item-service.ts).
export function CatalogItemFields({
  itemType,
  categories,
  item,
  tagNames = [],
}: {
  itemType: CatalogItemType;
  categories: Pick<CatalogCategory, "code" | "name">[];
  item?: CatalogItem;
  tagNames?: string[];
}) {
  return (
    <>
      <Field label="Name" name="name" defaultValue={item?.name ?? ""} required />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Category"
          name="categoryCode"
          required
          defaultValue={item?.categoryCode ?? ""}
          options={[
            { value: "", label: "Select a category…" },
            ...categories.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })),
          ]}
        />
        <Field label="Unit" name="unit" defaultValue={item?.unit ?? ""} placeholder="e.g. ea, sheet, sq ft, day" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Our cost ($)"
          name="unitCost"
          type="number"
          defaultValue={item?.unitCost?.toString() ?? ""}
          placeholder={itemType === "MATERIAL" ? "What we pay per unit" : "Optional"}
        />
        <Field
          label="Sell / rental price ($)"
          name="unitPrice"
          type="number"
          defaultValue={item?.unitPrice?.toString() ?? ""}
          placeholder={itemType === "MATERIAL" ? "Optional" : "What we charge per unit"}
        />
      </div>
      <TextareaField
        label="Description"
        name="description"
        rows={2}
        defaultValue={item?.description ?? ""}
        placeholder="Dimensions, color, finish -- whatever tells two similar items apart"
      />
      <Field
        label="Tags"
        name="tags"
        defaultValue={tagNames.join(", ")}
        placeholder="Comma-separated, e.g. fr-rated, ada, standard-rate"
      />
      <Field
        label="Source note"
        name="sourceNote"
        defaultValue={item?.sourceNote ?? ""}
        placeholder="Where this price came from -- a real job, a supplier quote, the standard cost sheet"
      />

      {itemType === "MATERIAL" && (
        <div className="border-t border-neutral-200 pt-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Cut-list stock setup</h2>
          <p className="mb-4 text-sm text-neutral-500">
            Only needed if this material is actually cut from raw stock -- the cut-list feature (nesting, cutting
            diagrams, DXF export) only works for a material with a type and stock dimensions set here.
          </p>
          <div className="flex flex-col gap-4">
            <SelectField
              label="Material type"
              name="materialType"
              defaultValue={item?.materialType ?? ""}
              options={MATERIAL_TYPE_OPTIONS}
            />
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Stock width (in)"
                name="stockWidth"
                type="number"
                defaultValue={item?.stockWidth?.toString() ?? ""}
                placeholder="e.g. 48 -- sheet goods only"
              />
              <Field
                label="Stock length (in)"
                name="stockLength"
                type="number"
                defaultValue={item?.stockLength?.toString() ?? ""}
                placeholder="e.g. 96"
              />
              <Field
                label="Thickness (in)"
                name="thickness"
                type="number"
                defaultValue={item?.thickness?.toString() ?? ""}
                placeholder="e.g. 0.75"
              />
              <Field
                label="Default kerf (in)"
                name="defaultKerf"
                type="number"
                defaultValue={item?.defaultKerf?.toString() ?? ""}
                placeholder="e.g. 0.125"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="grainDirectionMatters" defaultChecked={item?.grainDirectionMatters ?? false} />
              Grain direction matters -- parts cut from this material can&apos;t be freely rotated when nesting
            </label>
          </div>
        </div>
      )}
    </>
  );
}
