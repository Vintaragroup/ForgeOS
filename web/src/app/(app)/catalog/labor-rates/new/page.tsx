import { createLaborRate } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { LaborRateFields } from "@/components/labor-rate-fields";

export default function NewLaborRatePage() {
  return (
    <div>
      <PageHeader title="New labor rate" backHref="/catalog/labor-rates" backLabel="Labor rates" />
      <Card className="p-6">
        <form action={createLaborRate} className="flex flex-col gap-4">
          <LaborRateFields
            defaults={{
              rateType: "DEPARTMENT",
              departmentCode: "",
              departmentName: "",
              city: "",
              laborTier: "STRAIGHT_TIME",
              unionStatus: "",
              notes: "",
            }}
          />
          <Field label="Rate ($/hr)" name="rate" type="number" required />
          <div>
            <Button>Create labor rate</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
