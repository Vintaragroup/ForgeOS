import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteContact, updateContact } from "../actions";
import Link from "next/link";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";
import { AgingChip } from "@/components/aging-chip";
import { EMPTY_AGING, loadCompanyAging } from "@/lib/company-aging";

export default async function ContactDetailPage(props: PageProps<"/contacts/[id]">) {
  const { id } = await props.params;
  const [contact, companies] = await Promise.all([
    db.contact.findFirst({ where: { id, deletedAt: null } }),
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
  ]);
  if (!contact) notFound();
  // "Last worked with" is a company fact (jobs are won by companies), shown
  // here for context; "last contacted" is this person's own, from Salesmate.
  const companyAging = contact.companyId
    ? ((await loadCompanyAging([contact.companyId])).get(contact.companyId) ?? EMPTY_AGING)
    : EMPTY_AGING;
  const company = contact.companyId ? companies.find((c) => c.id === contact.companyId) : undefined;

  const updateContactWithId = updateContact.bind(null, contact.id);
  const deleteContactWithId = deleteContact.bind(null, contact.id);

  return (
    <div>
      <PageHeader title={contact.name} backHref="/contacts" backLabel="Contacts" />
      <Card className="mb-6 p-6">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Last contacted</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AgingChip date={contact.lastContactedAt} />
              <span className="text-sm text-neutral-600">
                {[contact.lastContactedMode, contact.lastContactedBy && `by ${contact.lastContactedBy}`].filter(Boolean).join(" · ")}
              </span>
            </div>
            {!contact.salesmateId && (
              <p className="mt-2 text-xs text-neutral-500">Not linked to a Salesmate contact, so there&apos;s no contact history.</p>
            )}
          </div>
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {company ? (
                <Link href={`/companies/${company.id}`} className="hover:underline">
                  {company.name}
                </Link>
              ) : (
                "Company"
              )}{" "}
              · last worked with
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AgingChip
                date={companyAging.lastWorkedWith?.at}
                emptyLabel={companyAging.wonWithoutShowDate > 0 ? "Won jobs, no show dates" : "No won jobs"}
              />
              {companyAging.lastWorkedWith && <span className="text-sm text-neutral-600">{companyAging.lastWorkedWith.label}</span>}
            </div>
          </div>
        </div>
      </Card>
      <Card className="p-6">
        <form action={updateContactWithId} className="flex flex-col gap-4">
          <Field label="Name" name="name" defaultValue={contact.name} required />
          <Field label="Email" name="email" type="email" defaultValue={contact.email ?? ""} />
          <Field label="Phone" name="phone" type="tel" defaultValue={contact.phone ?? ""} />
          <Field label="Mobile" name="mobile" type="tel" defaultValue={contact.mobile ?? ""} />
          <Field label="Title" name="title" defaultValue={contact.title ?? ""} placeholder="e.g. Marketing Director" />
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
        <ConfirmForm
          action={deleteContactWithId}
          confirmMessage="Delete this contact? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete contact</Button>
        </ConfirmForm>
      </Card>
    </div>
  );
}
