import { createCompany } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewCompanyPage() {
  return (
    <div>
      <PageHeader title="New company" backHref="/companies" backLabel="Companies" />
      <Card className="p-6">
        <form action={createCompany} className="flex flex-col gap-4">
          <Field label="Company name" name="name" required />
          <Field label="Billing address" name="billingAddress" />
          <Field label="Industry" name="industry" />
          <div>
            <Button>Create company</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
