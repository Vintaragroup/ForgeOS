import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteLaborRate, updateLaborRate } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";
import { LaborRateFields } from "@/components/labor-rate-fields";

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
        <form action={updateLaborRateWithId} className="flex flex-col gap-4">
          <LaborRateFields
            defaults={{
              rateType: rate.rateType,
              departmentCode: rate.departmentCode ?? "",
              departmentName: rate.departmentName ?? "",
              city: rate.city ?? "",
              laborTier: rate.laborTier ?? "STRAIGHT_TIME",
              unionStatus: rate.unionStatus ?? "",
              notes: rate.notes ?? "",
            }}
          />
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
