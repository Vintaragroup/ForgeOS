import { createRentalItem } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewRentalItemPage() {
  return (
    <div>
      <PageHeader title="New rental item" />
      <Card className="p-6">
        <form action={createRentalItem} className="flex flex-col gap-4">
          <Field label="Item name" name="name" required />
          <Field label="Unit price ($)" name="unitPrice" type="number" required />
          <Field
            label="Price derivation note"
            name="priceDerivationNote"
            placeholder="How this price was calculated, if not a flat rate"
          />
          <div>
            <Button>Create rental item</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
