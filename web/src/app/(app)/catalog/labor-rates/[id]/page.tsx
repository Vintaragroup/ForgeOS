import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteLaborRate, updateLaborRate } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

export default async function LaborRateDetailPage(props: PageProps<"/catalog/labor-rates/[id]">) {
  const { id } = await props.params;
  const rate = await db.laborRate.findFirst({ where: { id, deletedAt: null } });
  if (!rate) notFound();

  const updateLaborRateWithId = updateLaborRate.bind(null, rate.id);
  const deleteLaborRateWithId = deleteLaborRate.bind(null, rate.id);

  return (
    <div>
      <PageHeader
        title={rate.rateType === "DEPARTMENT" ? (rate.departmentName ?? "Labor rate") : (rate.city ?? "Labor rate")}
        backHref="/catalog/labor-rates"
        backLabel="Labor rates"
      />
      <Card className="p-6">
        <form action={updateLaborRateWithId} className="flex flex-col gap-4" key={rate.rateType}>
          <SelectField
            label="Rate type"
            name="rateType"
            defaultValue={rate.rateType}
            required
            options={[
              { value: "DEPARTMENT", label: "Department (internal shop labor)" },
              { value: "CITY_MARKET", label: "City market (on-site/show labor)" },
            ]}
          />
          <Field
            label="Department code"
            name="departmentCode"
            defaultValue={rate.departmentCode ?? ""}
            placeholder="e.g. EF"
          />
          <Field
            label="Department name"
            name="departmentName"
            defaultValue={rate.departmentName ?? ""}
            placeholder="e.g. Exhibit Fabrication"
          />
          <Field label="City" name="city" defaultValue={rate.city ?? ""} placeholder="e.g. Orlando, FL" />
          <Field label="Rate ($/hr)" name="rate" type="number" defaultValue={rate.rate.toString()} required />
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteLaborRateWithId}
          confirmMessage="Delete this labor rate? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete labor rate</Button>
        </ConfirmForm>
      </Card>
    </div>
  );
}
