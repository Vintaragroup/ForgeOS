import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteContact, updateContact } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

export default async function ContactDetailPage(props: PageProps<"/contacts/[id]">) {
  const { id } = await props.params;
  const [contact, companies] = await Promise.all([
    db.contact.findFirst({ where: { id, deletedAt: null } }),
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
  ]);
  if (!contact) notFound();

  const updateContactWithId = updateContact.bind(null, contact.id);
  const deleteContactWithId = deleteContact.bind(null, contact.id);

  return (
    <div>
      <PageHeader title={contact.name} />
      <Card className="p-6">
        <form action={updateContactWithId} className="flex flex-col gap-4">
          <Field label="Name" name="name" defaultValue={contact.name} required />
          <Field label="Email" name="email" type="email" defaultValue={contact.email ?? ""} />
          <Field label="Phone" name="phone" type="tel" defaultValue={contact.phone ?? ""} />
          <SelectField
            label="Role"
            name="role"
            defaultValue={contact.role}
            required
            options={[
              { value: "CLIENT_CONTACT", label: "Client contact" },
              { value: "ACCOUNT_EXECUTIVE", label: "Account executive" },
            ]}
          />
          <SelectField
            label="Company"
            name="companyId"
            defaultValue={contact.companyId ?? ""}
            options={[
              { value: "", label: "— none —" },
              ...companies.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <div>
            <Button>Save changes</Button>
          </div>
        </form>
        <form action={deleteContactWithId} className="mt-4 border-t border-neutral-200 pt-4">
          <Button variant="danger">Delete contact</Button>
        </form>
      </Card>
    </div>
  );
}
