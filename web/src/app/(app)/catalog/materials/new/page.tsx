import { createMaterial } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewMaterialPage() {
  return (
    <div>
      <PageHeader title="New material" />
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
          <div>
            <Button>Create material</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
