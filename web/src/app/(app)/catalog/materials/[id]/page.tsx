import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteMaterial, updateMaterial } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default async function MaterialDetailPage(props: PageProps<"/catalog/materials/[id]">) {
  const { id } = await props.params;
  const material = await db.material.findFirst({ where: { id, deletedAt: null } });
  if (!material) notFound();

  const updateMaterialWithId = updateMaterial.bind(null, material.id);
  const deleteMaterialWithId = deleteMaterial.bind(null, material.id);

  return (
    <div>
      <PageHeader title={material.name} />
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
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <form action={deleteMaterialWithId} className="mt-4 border-t border-neutral-200 pt-4">
          <Button variant="danger">Delete material</Button>
        </form>
      </Card>
    </div>
  );
}
