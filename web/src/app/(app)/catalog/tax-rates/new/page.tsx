import { createTaxRate } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewTaxRatePage() {
  return (
    <div>
      <PageHeader title="New tax rate" backHref="/catalog/tax-rates" backLabel="Tax rates" />
      <Card className="p-6">
        <form action={createTaxRate} className="flex flex-col gap-4">
          <Field label="State (2-letter code)" name="state" placeholder="FL" required />
          <Field label="City (optional)" name="city" placeholder="Orlando" />
          <Field
            label="Label (optional)"
            name="label"
            placeholder="Orange County, FL"
            defaultValue=""
          />
          <Field label="Tax rate (%)" name="rate" type="number" placeholder="6.5" required />
          <div>
            <Button>Create tax rate</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
