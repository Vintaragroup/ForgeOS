import { createLaborRate } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

export default function NewLaborRatePage() {
  return (
    <div>
      <PageHeader title="New labor rate" />
      <Card className="p-6">
        <form action={createLaborRate} className="flex flex-col gap-4">
          <SelectField
            label="Rate type"
            name="rateType"
            defaultValue="DEPARTMENT"
            required
            options={[
              { value: "DEPARTMENT", label: "Department (internal shop labor)" },
              { value: "CITY_MARKET", label: "City market (on-site/show labor)" },
            ]}
          />
          <Field label="Department code" name="departmentCode" placeholder="e.g. EF" />
          <Field label="Department name" name="departmentName" placeholder="e.g. Exhibit Fabrication" />
          <Field label="City" name="city" placeholder="e.g. Orlando, FL" />
          <Field label="Rate ($/hr)" name="rate" type="number" required />
          <div>
            <Button>Create labor rate</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
