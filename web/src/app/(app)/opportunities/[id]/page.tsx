import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { changeStage, deleteOpportunity, updateOpportunity } from "../actions";
import { convertToEstimate, convertToProject } from "../convert-actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

const STAGE_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "CONTACTED", label: "Contacted" },
  { value: "QUALIFIED", label: "Qualified" },
  { value: "ESTIMATING", label: "Estimating" },
  { value: "WON", label: "Won" },
  { value: "LOST", label: "Lost" },
];

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

export default async function OpportunityDetailPage(props: PageProps<"/opportunities/[id]">) {
  const { id } = await props.params;
  const opportunity = await db.opportunity.findFirst({
    where: { id, deletedAt: null },
    include: {
      company: true,
      estimates: { orderBy: { createdAt: "desc" } },
      projects: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
      stageEvents: { orderBy: { changedAt: "desc" } },
    },
  });
  if (!opportunity) notFound();

  const [companies, users, contacts] = await Promise.all([
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.contact.findMany({
      where: { deletedAt: null, companyId: opportunity.companyId },
      orderBy: { name: "asc" },
    }),
  ]);

  const updateWithId = updateOpportunity.bind(null, opportunity.id);
  const deleteWithId = deleteOpportunity.bind(null, opportunity.id);
  const changeStageWithId = changeStage.bind(null, opportunity.id);
  const convertWithId = convertToEstimate.bind(null, opportunity.id);
  const convertToProjectWithId = convertToProject.bind(null, opportunity.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={opportunity.showName} />

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Stage
        </h2>
        <form action={changeStageWithId} className="flex flex-wrap items-end gap-3">
          <SelectField
            // Forces React to remount this uncontrolled select whenever the
            // server-side stage changes -- otherwise the DOM node is reused
            // across the Server Action's re-render and keeps showing the
            // pre-submit value until a hard navigation.
            key={opportunity.stage}
            label="Move to"
            name="stage"
            defaultValue={opportunity.stage}
            options={STAGE_OPTIONS}
          />
          <div className="flex-1 min-w-[12rem]">
            <Field label="Note (optional)" name="note" />
          </div>
          <Button>Update stage</Button>
        </form>
        {opportunity.stageEvents.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1 border-t border-neutral-200 pt-4 text-sm text-neutral-500">
            {opportunity.stageEvents.map((e) => (
              <li key={e.id}>
                {e.changedAt.toISOString().slice(0, 16).replace("T", " ")} —{" "}
                {e.fromStage ? `${e.fromStage} → ${e.toStage}` : `created at ${e.toStage}`}
                {e.note ? ` (${e.note})` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Details
        </h2>
        <form action={updateWithId} className="flex flex-col gap-4">
          <SelectField
            label="Company"
            name="companyId"
            defaultValue={opportunity.companyId}
            required
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Field label="Show name" name="showName" defaultValue={opportunity.showName} required />
          <Field label="Booth number" name="boothNumber" defaultValue={opportunity.boothNumber ?? ""} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Target move-in" name="targetMoveIn" type="date" defaultValue={fmtDate(opportunity.targetMoveIn)} />
            <Field label="Target move-out" name="targetMoveOut" type="date" defaultValue={fmtDate(opportunity.targetMoveOut)} />
          </div>
          <SelectField
            label="Primary contact"
            name="primaryContactId"
            defaultValue={opportunity.primaryContactId ?? ""}
            options={[
              { value: "", label: "— none —" },
              ...contacts.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <SelectField
            label="Owner"
            name="ownerId"
            defaultValue={opportunity.ownerId ?? ""}
            options={[
              { value: "", label: "— unassigned —" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
          <div>
            <Button>Save changes</Button>
          </div>
        </form>
        <form action={deleteWithId} className="mt-4 border-t border-neutral-200 pt-4">
          <Button variant="danger">Delete opportunity</Button>
        </form>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Estimates
        </h2>
        {opportunity.estimates.length === 0 ? (
          <p className="mb-4 text-sm text-neutral-500">
            No estimate started yet. Converting pre-fills job details from this opportunity.
          </p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2 text-sm">
            {opportunity.estimates.map((e) => (
              <li key={e.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                <span>
                  Estimate {e.id.slice(0, 8)} — {e.status}
                  {e.taxCity ? ` · ${e.taxCity}` : ""}
                </span>
                <Link href={`/estimates/${e.id}`} className="text-neutral-900 hover:underline">
                  Open estimate →
                </Link>
              </li>
            ))}
          </ul>
        )}
        <form action={convertWithId}>
          <Button variant="secondary">Convert to estimate</Button>
        </form>
      </Card>

      {opportunity.stage === "WON" && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Project
          </h2>
          {opportunity.projects.length === 0 ? (
            <>
              <p className="mb-4 text-sm text-neutral-500">
                No project started yet. Converting creates the production/logistics record for this won job.
              </p>
              <form action={convertToProjectWithId}>
                <Button variant="secondary">Convert to Project</Button>
              </form>
            </>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {opportunity.projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                  <span>
                    {p.jobNumber ? `Job ${p.jobNumber}` : `Project ${p.id.slice(0, 8)}`} — {p.status}
                  </span>
                  <Link href={`/projects/${p.id}`} className="text-neutral-900 hover:underline">
                    Open project →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
