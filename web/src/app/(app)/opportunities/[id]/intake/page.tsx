import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { canViewWholeTeam } from "@/lib/sales-analytics";
import { assignableUsers, loadIntakeStatus, type IntakeRequirement } from "@/lib/opportunity-intake";
import { Button, Card, Field, PageHeader, SelectField, StatusChip, TextareaField } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { ConfirmForm } from "@/components/confirm-form";
import { LocalTimestamp } from "@/components/local-timestamp";
import {
  addIntakeNoteAction,
  addShowDeadlineAction,
  assignTeamAction,
  completeReviewAction,
  deleteIntakeNoteAction,
  deleteShowDeadlineAction,
  saveIntakeDetailsAction,
  scheduleReviewAction,
  submitForReviewAction,
} from "./actions";

export const dynamic = "force-dynamic";

const NOTE_KIND_LABELS: Record<string, string> = {
  CLIENT_MEETING: "Client meeting",
  CLIENT_CALL: "Client call",
  INTERNAL: "Internal",
  SITE_VISIT: "Site visit",
  OTHER: "Other",
};

function dateValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

function SectionMissing({ missing, section }: { missing: IntakeRequirement[]; section: string }) {
  const here = missing.filter((m) => m.section === section);
  if (here.length === 0) return null;
  return (
    <p className="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      Still needed: {here.map((m) => m.label.toLowerCase()).join(", ")}.
    </p>
  );
}

// The rep's gathering step: everything about the job in one place, with
// what's still missing called out per section, ending in "submit for
// client review". The gate itself lives in lib/opportunity-intake.ts --
// this page reads the same requirement list, so the button and the rule
// can't disagree.
export default async function IntakePage(props: PageProps<"/opportunities/[id]/intake">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const opportunity = await db.opportunity.findFirst({
    where: { id, deletedAt: null },
    include: {
      company: { select: { id: true, name: true, contacts: { where: { deletedAt: null }, orderBy: { name: "asc" } } } },
      notes: { where: { deletedAt: null }, orderBy: { occurredAt: "desc" }, include: { author: { select: { name: true } } } },
      showDeadlines: { where: { deletedAt: null }, orderBy: { dueDate: "asc" } },
      designer: { select: { name: true } },
      estimator: { select: { name: true } },
      intakeSubmittedBy: { select: { name: true } },
      _count: { select: { documents: { where: { deletedAt: null } } } },
    },
  });
  if (!opportunity) notFound();
  if (!(await canAccessOpportunity(user, opportunity.id))) notFound();

  const [status, assignable] = await Promise.all([loadIntakeStatus(opportunity.id), assignableUsers()]);
  const isManager = canViewWholeTeam(user);
  const submitted = Boolean(status.submittedAt);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Intake — ${opportunity.company.name}`}
        backHref={`/opportunities/${opportunity.id}`}
        backLabel="Opportunity"
      />

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Client review</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {!submitted ? (
                status.complete ? (
                  <StatusChip tone="good">Ready to submit</StatusChip>
                ) : (
                  <StatusChip tone="warning">{status.missing.length} thing(s) still needed</StatusChip>
                )
              ) : status.reviewCompletedAt ? (
                <StatusChip tone="good">Review complete</StatusChip>
              ) : status.reviewMeetingAt ? (
                <StatusChip tone="info">Meeting set</StatusChip>
              ) : (
                <StatusChip tone="warning">Waiting to be scheduled</StatusChip>
              )}
              {submitted && (
                <span className="text-neutral-600">
                  submitted by {opportunity.intakeSubmittedBy?.name ?? "a rep"} on{" "}
                  <LocalTimestamp iso={status.submittedAt!} timeStyle={undefined} />
                </span>
              )}
            </div>
            {!submitted && !status.complete && (
              <ul className="mt-3 list-disc pl-5 text-sm text-neutral-600">
                {status.missing.map((m) => (
                  <li key={m.key}>{m.label}</li>
                ))}
              </ul>
            )}
          </div>
          {!submitted && (
            <ActionForm action={submitForReviewAction.bind(null, opportunity.id)}>
              <Button>{status.complete ? "Submit for client review" : "Submit (incomplete)"}</Button>
            </ActionForm>
          )}
        </div>
      </Card>

      {submitted && isManager && (
        <Card className="p-6">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Schedule &amp; assign</h2>
          <p className="mb-4 text-sm text-neutral-500">
            Sales management sets the client review meeting and names who designs and estimates it.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <ActionForm action={scheduleReviewAction.bind(null, opportunity.id)} className="flex flex-col gap-3">
              <Field
                label="Client review meeting"
                name="reviewMeetingAt"
                type="datetime-local"
                defaultValue={status.reviewMeetingAt ? status.reviewMeetingAt.toISOString().slice(0, 16) : ""}
              />
              <div>
                <Button variant="secondary">{status.reviewMeetingAt ? "Update meeting" : "Set meeting"}</Button>
              </div>
            </ActionForm>

            <ActionForm action={assignTeamAction.bind(null, opportunity.id)} className="flex flex-col gap-3">
              <SelectField
                label="Designer"
                name="designerId"
                defaultValue={status.designerId ?? ""}
                options={[
                  { value: "", label: assignable.designers.length ? "— unassigned —" : "— nobody is in Design yet —" },
                  ...assignable.designers.map((d) => ({ value: d.id, label: d.name })),
                ]}
              />
              <SelectField
                label="Estimator"
                name="estimatorId"
                defaultValue={status.estimatorId ?? ""}
                options={[
                  { value: "", label: assignable.estimators.length ? "— unassigned —" : "— nobody is in Estimating yet —" },
                  ...assignable.estimators.map((e) => ({ value: e.id, label: e.name })),
                ]}
              />
              <div>
                <Button variant="secondary">Save team</Button>
              </div>
            </ActionForm>
          </div>
          {(assignable.designers.length === 0 || assignable.estimators.length === 0) && (
            <p className="mt-3 text-xs text-amber-700">
              Assign people to the Design and Estimating departments in{" "}
              <Link href="/admin/users" className="underline">
                Admin → Users
              </Link>{" "}
              before they can be picked here.
            </p>
          )}
          {!status.reviewCompletedAt && (
            <ActionForm action={completeReviewAction.bind(null, opportunity.id)} className="mt-4 border-t border-neutral-200 pt-4">
              <Button variant="secondary">Mark review complete</Button>
            </ActionForm>
          )}
        </Card>
      )}

      <Card className="p-6">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-neutral-500">The job</h2>
        <ActionForm action={saveIntakeDetailsAction.bind(null, opportunity.id)} className="flex flex-col gap-6">
          <div>
            <SectionMissing missing={status.missing} section="client" />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Primary client contact"
                name="primaryContactId"
                defaultValue={opportunity.primaryContactId ?? ""}
                options={[
                  { value: "", label: opportunity.company.contacts.length ? "— none —" : "— no contacts on this company —" },
                  ...opportunity.company.contacts.map((c) => ({ value: c.id, label: c.email ? `${c.name} (${c.email})` : c.name })),
                ]}
              />
              <div className="flex items-end">
                <Link href={`/companies/${opportunity.company.id}`} className="text-sm text-brand-navy underline">
                  {opportunity.company.name} →
                </Link>
              </div>
            </div>
          </div>

          <div>
            <SectionMissing missing={status.missing} section="show" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Show name" name="showName" required defaultValue={opportunity.showName} />
              <Field label="Venue" name="venue" defaultValue={opportunity.venue ?? ""} />
              <Field label="Event start" name="eventStartDate" type="date" defaultValue={dateValue(opportunity.eventStartDate)} />
              <Field label="Event end" name="eventEndDate" type="date" defaultValue={dateValue(opportunity.eventEndDate)} />
            </div>
          </div>

          <div>
            <SectionMissing missing={status.missing} section="booth" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Booth number" name="boothNumber" defaultValue={opportunity.boothNumber ?? ""} />
              <Field label="Booth size" name="boothSize" defaultValue={opportunity.boothSize ?? ""} placeholder="e.g. 20x20" />
              <SelectField
                label="Booth space"
                name="boothSpace"
                defaultValue={opportunity.boothSpace ?? ""}
                options={[
                  { value: "", label: "— not set —" },
                  { value: "IN_LINE", label: "In-line" },
                  { value: "PERIMETER", label: "Perimeter" },
                  { value: "PENINSULA", label: "Peninsula" },
                  { value: "ISLAND", label: "Island" },
                ]}
              />
              <SelectField
                label="Booth type"
                name="boothType"
                defaultValue={opportunity.boothType ?? ""}
                options={[
                  { value: "", label: "— not set —" },
                  { value: "RENTAL", label: "Rental" },
                  { value: "PURCHASE", label: "Purchase" },
                  { value: "CLIENT_OWNED", label: "Client owned" },
                ]}
              />
            </div>
          </div>

          <div>
            <SectionMissing missing={status.missing} section="logistics" />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Target move-in" name="targetMoveIn" type="date" defaultValue={dateValue(opportunity.targetMoveIn)} />
              <Field label="Target move-out" name="targetMoveOut" type="date" defaultValue={dateValue(opportunity.targetMoveOut)} />
              <Field label="Ship date" name="shipDate" type="date" defaultValue={dateValue(opportunity.shipDate)} />
            </div>
            <div className="mt-4">
              <Field label="Site address" name="siteAddress" defaultValue={opportunity.siteAddress ?? ""} />
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Exhibitor information</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Show contact" name="showContactName" defaultValue={opportunity.showContactName ?? ""} />
              <Field label="Show contact email" name="showContactEmail" type="email" defaultValue={opportunity.showContactEmail ?? ""} />
              <Field label="Show contact phone" name="showContactPhone" type="tel" defaultValue={opportunity.showContactPhone ?? ""} />
              <Field
                label="Exhibitor kit / manual link"
                name="exhibitorKitUrl"
                defaultValue={opportunity.exhibitorKitUrl ?? ""}
                placeholder="https://…"
              />
              <Field
                label="Exhibitor / booth account"
                name="exhibitorAccountRef"
                defaultValue={opportunity.exhibitorAccountRef ?? ""}
                placeholder="The client's account with show management"
              />
              <Field label="Hall" name="hall" defaultValue={opportunity.hall ?? ""} />
            </div>
            <div className="mt-4">
              <TextareaField
                label="Hall detail"
                name="hallDetail"
                rows={2}
                defaultValue={opportunity.hallDetail ?? ""}
                placeholder="Aisle, neighbouring booths, ceiling height, floor load…"
              />
            </div>
          </div>

          <TextareaField
            label="Scope / project details"
            name="projectDetails"
            rows={4}
            defaultValue={opportunity.projectDetails ?? ""}
            placeholder="What are we building, and anything the client has asked for that doesn't fit a field above."
          />

          <div>
            <Button>Save details</Button>
          </div>
        </ActionForm>
      </Card>

      <Card className="p-6">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Notes</h2>
        <p className="mb-4 text-sm text-neutral-500">
          What was said, and when. A client meeting or call note is required before this can go to review — it&apos;s what
          the review meeting works from.
        </p>
        <SectionMissing missing={status.missing} section="notes" />

        <ActionForm action={addIntakeNoteAction.bind(null, opportunity.id)} resetOnSuccess className="mb-5 flex flex-col gap-3">
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label="Kind"
              name="kind"
              defaultValue="CLIENT_MEETING"
              options={Object.entries(NOTE_KIND_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <Field label="When" name="occurredAt" type="date" defaultValue={dateValue(new Date())} />
            <Field label="Department (optional)" name="departmentCode" placeholder="e.g. DE, ES" />
          </div>
          <TextareaField label="Note" name="body" rows={3} placeholder="What the client asked for, decisions made, open questions…" />
          <div>
            <Button variant="secondary">Add note</Button>
          </div>
        </ActionForm>

        {opportunity.notes.length === 0 ? (
          <p className="text-sm text-neutral-500">No notes yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {opportunity.notes.map((note) => (
              <li key={note.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                    <StatusChip tone={note.kind.startsWith("CLIENT") ? "info" : "neutral"}>
                      {NOTE_KIND_LABELS[note.kind] ?? note.kind}
                    </StatusChip>
                    <LocalTimestamp iso={note.occurredAt} timeStyle={undefined} />
                    {note.author && <span>· {note.author.name}</span>}
                    {note.departmentCode && <span>· {note.departmentCode}</span>}
                  </div>
                  <ConfirmForm
                    action={deleteIntakeNoteAction.bind(null, opportunity.id, note.id)}
                    confirmMessage="Delete this note?"
                  >
                    <button type="submit" className="text-xs text-neutral-500 hover:text-red-700">
                      Delete
                    </button>
                  </ConfirmForm>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm">{note.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Show deadlines</h2>
        <p className="mb-4 text-sm text-neutral-500">
          From the exhibitor manual — electrical, rigging, drayage, discount cut-offs.
        </p>
        <ActionForm action={addShowDeadlineAction.bind(null, opportunity.id)} resetOnSuccess className="mb-5 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <Field label="Deadline" name="label" placeholder="e.g. Electrical discount cut-off" />
          </div>
          <div className="min-w-40">
            <Field label="Due" name="dueDate" type="date" />
          </div>
          <div className="min-w-48 flex-1">
            <Field label="Note (optional)" name="note" />
          </div>
          <Button variant="secondary">Add</Button>
        </ActionForm>

        {opportunity.showDeadlines.length === 0 ? (
          <p className="text-sm text-neutral-500">No deadlines recorded.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {opportunity.showDeadlines.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span>
                  <span className="font-medium">{d.label}</span>
                  {d.note && <span className="text-neutral-500"> — {d.note}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
                  <LocalTimestamp iso={d.dueDate} timeStyle={undefined} />
                  <ConfirmForm
                    action={deleteShowDeadlineAction.bind(null, opportunity.id, d.id)}
                    confirmMessage="Remove this deadline?"
                  >
                    <button type="submit" className="hover:text-red-700">
                      Remove
                    </button>
                  </ConfirmForm>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Documents</h2>
        <p className="text-sm text-neutral-500">
          {opportunity._count.documents} uploaded.{" "}
          <Link href={`/opportunities/${opportunity.id}?tab=documents`} className="underline">
            Upload or review them on the opportunity →
          </Link>
        </p>
      </Card>

      {(status.designerId || status.estimatorId) && (
        <Card className="p-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Assigned team</h2>
          <p className="text-sm text-neutral-700">
            Designer: {opportunity.designer?.name ?? "unassigned"} · Estimator: {opportunity.estimator?.name ?? "unassigned"}
          </p>
        </Card>
      )}
    </div>
  );
}
