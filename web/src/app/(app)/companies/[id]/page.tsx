import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { deleteCompany, updateCompany } from "../actions";
import { taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

export default async function CompanyDetailPage(props: PageProps<"/companies/[id]">) {
  const { id } = await props.params;
  const [company, taxRates] = await Promise.all([
    db.company.findFirst({
      where: { id, deletedAt: null },
      include: {
        contacts: { where: { deletedAt: null } },
        opportunities: { where: { deletedAt: null } },
      },
    }),
    db.taxRate.findMany(TAX_RATE_PICKER_QUERY),
  ]);
  if (!company) notFound();

  const updateCompanyWithId = updateCompany.bind(null, company.id);
  const deleteCompanyWithId = deleteCompany.bind(null, company.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={company.name} backHref="/companies" backLabel="Companies" />

      <Card className="p-6">
        <form action={updateCompanyWithId} className="flex flex-col gap-4">
          <Field label="Company name" name="name" defaultValue={company.name} required />
          <Field
            label="Billing address"
            name="billingAddress"
            defaultValue={company.billingAddress ?? ""}
          />
          <Field label="Industry" name="industry" defaultValue={company.industry ?? ""} />
          <SelectField
            label="Default tax jurisdiction"
            name="taxRateId"
            defaultValue={company.taxRateId ?? ""}
            options={[
              { value: "", label: "— none —" },
              ...taxRates.map((t) => ({ value: t.id, label: taxRateOptionLabel(t) })),
            ]}
          />
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteCompanyWithId}
          confirmMessage="Delete this company? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete company</Button>
        </ConfirmForm>
      </Card>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Contacts</h2>
        {company.contacts.length === 0 ? (
          <p className="text-sm text-neutral-500">No contacts yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-neutral-200">
              {company.contacts.map((c) => (
                <li key={c.id}>
                  <Link href={`/contacts/${c.id}`} className="block px-5 py-3 hover:bg-neutral-50">
                    {c.name} <span className="text-sm text-neutral-500">— {c.email ?? "no email"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Opportunities</h2>
        {company.opportunities.length === 0 ? (
          <p className="text-sm text-neutral-500">No opportunities yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-neutral-200">
              {company.opportunities.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/opportunities/${o.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                  >
                    <span>{o.showName}</span>
                    <span className="text-sm text-neutral-500">{o.stage}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
