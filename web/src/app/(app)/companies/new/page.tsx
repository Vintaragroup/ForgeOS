import { createCompany } from "../actions";
import { db } from "@/lib/db";
import { taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

export default async function NewCompanyPage() {
  const taxRates = await db.taxRate.findMany(TAX_RATE_PICKER_QUERY);

  return (
    <div>
      <PageHeader title="New company" backHref="/companies" backLabel="Companies" />
      <Card className="p-6">
        <form action={createCompany} className="flex flex-col gap-4">
          <Field label="Company name" name="name" required />
          <Field label="Billing address" name="billingAddress" />
          <Field label="Industry" name="industry" />
          <SelectField
            label="Default tax jurisdiction"
            name="taxRateId"
            defaultValue=""
            options={[
              { value: "", label: "— none —" },
              ...taxRates.map((t) => ({ value: t.id, label: taxRateOptionLabel(t) })),
            ]}
          />
          <div>
            <Button>Create company</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
