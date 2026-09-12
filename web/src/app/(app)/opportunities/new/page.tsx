import { db } from "@/lib/db";
import { createOpportunity } from "../actions";
import { taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { ProjectTypeFields } from "@/components/project-type-fields";
import { OpportunityNamePreview } from "@/components/opportunity-name-preview";
import { CompanyFieldWithCreate } from "@/components/company-field-with-create";

// The company/user dropdowns must reflect live data, not a build-time
// snapshot -- see opportunities/page.tsx's comment for the same reasoning.
export const dynamic = "force-dynamic";

export default async function NewOpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ showId?: string }>;
}) {
  const { showId: prefillShowId } = await searchParams;
  const [companies, users, taxRates, shows] = await Promise.all([
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.taxRate.findMany(TAX_RATE_PICKER_QUERY),
    db.show.findMany({ where: { deletedAt: null }, orderBy: { eventStartDate: "desc" } }),
  ]);
  // Arriving from a Show's own "add a new client" link -- pre-select that
  // Show and pre-fill the show-name/venue/dates fields from it, still
  // editable (a client's own display label can differ slightly from the
  // Show's canonical name).
  const prefillShow = prefillShowId ? shows.find((s) => s.id === prefillShowId) : undefined;

  return (
    <div>
      <PageHeader title="New opportunity" backHref="/opportunities" backLabel="Opportunities" />
      <Card className="p-6">
        <form action={createOpportunity} className="flex flex-col gap-4">
          <CompanyFieldWithCreate companies={companies.map((c) => ({ id: c.id, name: c.name }))} />
          <SelectField
            label="Show"
            name="showId"
            defaultValue={prefillShow?.id ?? ""}
            options={[{ value: "", label: "— none (standalone job) —" }, ...shows.map((s) => ({ value: s.id, label: s.name }))]}
          />
          <Field label="Show name" name="showName" required defaultValue={prefillShow?.name ?? ""} />
          <OpportunityNamePreview companies={companies.map((c) => ({ id: c.id, name: c.name }))} />
          <ProjectTypeFields
            defaults={{
              projectType: "TRADESHOW_EXHIBIT",
              boothNumber: "",
              boothSize: "",
              boothSpace: "",
              boothType: "",
              shipDate: "",
              venue: prefillShow?.venue ?? "",
              eventStartDate: prefillShow?.eventStartDate?.toISOString().slice(0, 10) ?? "",
              eventEndDate: prefillShow?.eventEndDate?.toISOString().slice(0, 10) ?? "",
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
