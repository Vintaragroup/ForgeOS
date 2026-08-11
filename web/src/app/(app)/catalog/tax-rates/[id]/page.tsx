import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteTaxRate, updateTaxRate } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

export default async function TaxRateDetailPage(props: PageProps<"/catalog/tax-rates/[id]">) {
  const { id } = await props.params;
  const rate = await db.taxRate.findFirst({ where: { id, deletedAt: null } });
  if (!rate) notFound();

  const updateTaxRateWithId = updateTaxRate.bind(null, rate.id);
  const deleteTaxRateWithId = deleteTaxRate.bind(null, rate.id);

  return (
    <div>
      <PageHeader
        title={rate.label ?? (rate.city ? `${rate.city}, ${rate.state}` : rate.state)}
        backHref="/catalog/tax-rates"
        backLabel="Tax rates"
      />
      <Card className="p-6">
        <form action={updateTaxRateWithId} className="flex flex-col gap-4">
          <Field label="State (2-letter code)" name="state" defaultValue={rate.state} required />
          <Field label="City (optional)" name="city" defaultValue={rate.city ?? ""} placeholder="Orlando" />
          <Field label="Label (optional)" name="label" defaultValue={rate.label ?? ""} placeholder="Orange County, FL" />
          <Field
            label="Tax rate (%)"
            name="rate"
            type="number"
            defaultValue={(rate.rate.toNumber() * 100).toString()}
            required
          />
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteTaxRateWithId}
          confirmMessage="Delete this tax rate? Estimates already using it keep referencing it, but it won't appear in the picker for new selections. This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete tax rate</Button>
        </ConfirmForm>
      </Card>
    </div>
  );
}
