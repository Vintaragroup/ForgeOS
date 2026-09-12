import { createVendor } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewVendorPage() {
  return (
    <div>
      <PageHeader title="New vendor" backHref="/catalog/vendors" backLabel="Vendors" />
      <Card className="p-6">
        <form action={createVendor} className="flex flex-col gap-4">
          <Field label="Vendor name" name="name" required />
          <Field label="Email" name="email" type="email" placeholder="e.g. jobs@vendor.com" />
          <Field label="Contact info" name="contactInfo" placeholder="e.g. phone" />
          <Field label="Category" name="category" placeholder="e.g. Furniture rental, Printing" />
          <div>
            <Button>Create vendor</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
