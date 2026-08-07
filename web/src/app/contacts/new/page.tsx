import { db } from "@/lib/db";
import { createContact } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

export default async function NewContactPage() {
  const companies = await db.company.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <PageHeader title="New contact" />
      <Card className="p-6">
        <form action={createContact} className="flex flex-col gap-4">
          <Field label="Name" name="name" required />
          <Field label="Email" name="email" type="email" />
          <Field label="Phone" name="phone" type="tel" />
          <SelectField
            label="Role"
            name="role"
            required
            options={[
              { value: "CLIENT_CONTACT", label: "Client contact" },
              { value: "ACCOUNT_EXECUTIVE", label: "Account executive" },
            ]}
          />
          <SelectField
            label="Company"
            name="companyId"
            options={[
              { value: "", label: "— none —" },
              ...companies.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <div>
            <Button>Create contact</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
