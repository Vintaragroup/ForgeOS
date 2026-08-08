import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteVendor, updateVendor } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default async function VendorDetailPage(props: PageProps<"/catalog/vendors/[id]">) {
  const { id } = await props.params;
  const vendor = await db.vendor.findFirst({ where: { id, deletedAt: null } });
  if (!vendor) notFound();

  const updateWithId = updateVendor.bind(null, vendor.id);
  const deleteWithId = deleteVendor.bind(null, vendor.id);

  return (
    <div>
      <PageHeader title={vendor.name} />
      <Card className="p-6">
        <form action={updateWithId} className="flex flex-col gap-4">
          <Field label="Vendor name" name="name" defaultValue={vendor.name} required />
          <Field
            label="Contact info"
            name="contactInfo"
            defaultValue={vendor.contactInfo ?? ""}
            placeholder="e.g. phone, email"
          />
          <Field
            label="Category"
            name="category"
            defaultValue={vendor.category ?? ""}
            placeholder="e.g. Furniture rental, Printing"
          />
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <form action={deleteWithId} className="mt-4 border-t border-neutral-200 pt-4">
          <Button variant="danger">Delete vendor</Button>
        </form>
      </Card>
    </div>
  );
}
