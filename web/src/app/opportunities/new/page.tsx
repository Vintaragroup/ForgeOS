import { db } from "@/lib/db";
import { createOpportunity } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { EmptyState, LinkButton } from "@/components/ui";

export default async function NewOpportunityPage() {
  const [companies, users] = await Promise.all([
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
  ]);

  if (companies.length === 0) {
    return (
      <div>
        <PageHeader title="New opportunity" />
        <EmptyState message="You need at least one company before creating an opportunity." />
        <div className="mt-4">
          <LinkButton href="/companies/new">Add a company</LinkButton>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="New opportunity" />
      <Card className="p-6">
        <form action={createOpportunity} className="flex flex-col gap-4">
          <SelectField
            label="Company"
            name="companyId"
            required
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Field label="Show name" name="showName" required />
          <Field label="Booth number" name="boothNumber" />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Target move-in" name="targetMoveIn" type="date" />
            <Field label="Target move-out" name="targetMoveOut" type="date" />
          </div>
          <SelectField
            label="Owner"
            name="ownerId"
            options={[
              { value: "", label: "— unassigned —" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
          <div>
            <Button>Create opportunity</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
