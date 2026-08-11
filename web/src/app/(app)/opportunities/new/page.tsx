import { db } from "@/lib/db";
import { createOpportunity } from "../actions";
import { taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { EmptyState, LinkButton } from "@/components/ui";
import { ProjectTypeFields } from "@/components/project-type-fields";

// The company/user dropdowns must reflect live data, not a build-time
// snapshot -- see opportunities/page.tsx's comment for the same reasoning.
export const dynamic = "force-dynamic";

export default async function NewOpportunityPage() {
  const [companies, users, taxRates] = await Promise.all([
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.taxRate.findMany(TAX_RATE_PICKER_QUERY),
  ]);

  if (companies.length === 0) {
    return (
      <div>
        <PageHeader title="New opportunity" backHref="/opportunities" backLabel="Opportunities" />
        <EmptyState message="You need at least one company before creating an opportunity." />
        <div className="mt-4">
          <LinkButton href="/companies/new">Add a company</LinkButton>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="New opportunity" backHref="/opportunities" backLabel="Opportunities" />
      <Card className="p-6">
        <form action={createOpportunity} className="flex flex-col gap-4">
          <SelectField
            label="Company"
            name="companyId"
            required
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Field label="Show name" name="showName" required />
          <ProjectTypeFields
            defaults={{
              projectType: "TRADESHOW_EXHIBIT",
              boothNumber: "",
              boothSize: "",
              boothSpace: "",
              boothType: "",
              shipDate: "",
              venue: "",
              eventStartDate: "",
              eventEndDate: "",
              siteAddress: "",
              projectDetails: "",
            }}
          />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Target move-in" name="targetMoveIn" type="date" />
            <Field label="Target move-out" name="targetMoveOut" type="date" />
          </div>
          <SelectField
            label="Tax jurisdiction"
            name="taxRateId"
            defaultValue=""
            options={[
              { value: "", label: "— use company's default —" },
              { value: "__none__", label: "— none —" },
              ...taxRates.map((t) => ({ value: t.id, label: taxRateOptionLabel(t) })),
            ]}
          />
          <SelectField
            label="Owner"
            name="ownerId"
            options={[
              { value: "", label: "— unassigned —" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
          {users.length > 0 && (
            <div>
              <span className="mb-1.5 block text-sm font-medium text-neutral-700">
                Share with teammates
              </span>
              <p className="mb-2 text-xs text-neutral-500">
                Checked teammates can see and work on this opportunity, in addition to its owner.
              </p>
              <ul className="flex flex-col gap-2 text-sm">
                {users.map((u) => (
                  <li key={u.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`collaborator-${u.id}`}
                      name="collaboratorIds"
                      value={u.id}
                      className="h-4 w-4 rounded border-neutral-300"
                    />
                    <label htmlFor={`collaborator-${u.id}`}>{u.name}</label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <Button>Create opportunity</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
