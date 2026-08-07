import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteRentalItem, updateRentalItem } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default async function RentalItemDetailPage(props: PageProps<"/catalog/rental-items/[id]">) {
  const { id } = await props.params;
  const item = await db.rentalItem.findFirst({ where: { id, deletedAt: null } });
  if (!item) notFound();

  const updateRentalItemWithId = updateRentalItem.bind(null, item.id);
  const deleteRentalItemWithId = deleteRentalItem.bind(null, item.id);

  return (
    <div>
      <PageHeader title={item.name} />
      <Card className="p-6">
        <form action={updateRentalItemWithId} className="flex flex-col gap-4">
          <Field label="Item name" name="name" defaultValue={item.name} required />
          <Field
            label="Unit price ($)"
            name="unitPrice"
            type="number"
            defaultValue={item.unitPrice.toString()}
            required
          />
          <Field
            label="Price derivation note"
            name="priceDerivationNote"
            defaultValue={item.priceDerivationNote ?? ""}
            placeholder="How this price was calculated, if not a flat rate"
          />
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <form action={deleteRentalItemWithId} className="mt-4 border-t border-neutral-200 pt-4">
          <Button variant="danger">Delete rental item</Button>
        </form>
      </Card>
    </div>
  );
}
