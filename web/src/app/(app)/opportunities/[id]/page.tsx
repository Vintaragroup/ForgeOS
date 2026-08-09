import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { changeStage, deleteOpportunity, updateOpportunity } from "../actions";
import { convertToEstimate, convertToProject } from "../convert-actions";
import { analyzeDocumentAction, deleteDocumentAction, uploadDocumentAction } from "./documents/actions";
import { listDocuments } from "@/lib/document-service";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { Button, Card, Field, LinkButton, PageHeader, SelectField, StatusChip } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

const DOCUMENT_TYPE_OPTIONS = [
  { value: "RFP", label: "RFP" },
  { value: "SCOPE_OF_WORK", label: "Scope of work" },
  { value: "PRICING_SCHEDULE", label: "Pricing schedule" },
  { value: "DRAWING", label: "Drawing / CAD export" },
  { value: "CONTRACT", label: "Contract" },
  { value: "SCHEDULE", label: "Schedule" },
  { value: "OTHER", label: "Other" },
];

function ExtractionStatusChip({ status }: { status: string }) {
  switch (status) {
    case "COMPLETE":
      return <StatusChip tone="good">Analyzed</StatusChip>;
    case "PROCESSING":
      return <StatusChip tone="info">Analyzing…</StatusChip>;
    case "FAILED":
      return <StatusChip tone="critical">Analysis failed</StatusChip>;
    case "UNSUPPORTED":
      return <StatusChip tone="warning">Not analyzable</StatusChip>;
    default:
      return <StatusChip tone="neutral">Not analyzed</StatusChip>;
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Merged at read time from every analyzed document, not stored as its own
// aggregate -- consistent with the rest of this app computing rollups
// live (e.g. admin-analytics.ts) rather than caching a stale summary.
function ProjectBriefCard({
  documents,
}: {
  documents: { id: string; filename: string; extractionStatus: string; extractedSummary: unknown }[];
}) {
  const analyzed = documents.filter(
    (d) => d.extractionStatus === "COMPLETE" && d.extractedSummary,
  ) as { id: string; filename: string; extractionStatus: string; extractedSummary: DocumentSummary }[];

  if (analyzed.length === 0) return null;

  const eventOrProjectName = analyzed.map((d) => d.extractedSummary.eventOrProjectName).find(Boolean);
  const venue = analyzed.map((d) => d.extractedSummary.venue).find(Boolean);
  const submissionDeadline = analyzed.map((d) => d.extractedSummary.submissionDeadline).find(Boolean);
  const keyDates = analyzed.flatMap((d) =>
    d.extractedSummary.keyDates.map((kd) => ({ ...kd, source: d.filename })),
  );
  const scopeSummary = analyzed.flatMap((d) =>
    d.extractedSummary.scopeSummary.map((s) => ({ text: s, source: d.filename })),
  );
  const riskFlags = analyzed.flatMap((d) =>
    d.extractedSummary.riskFlags.map((r) => ({ text: r, source: d.filename })),
  );

  return (
    <Card className="p-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Project brief
      </h2>
      <p className="mb-4 text-sm text-neutral-500">
        Extracted from {analyzed.length} analyzed document{analyzed.length === 1 ? "" : "s"} — verify against
        the source before relying on it.
      </p>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-400">Event / project</div>
          <div className="text-sm font-medium">{eventOrProjectName ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-400">Venue</div>
          <div className="text-sm font-medium">{venue ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-400">Submission deadline</div>
          <div className="text-sm font-medium">{submissionDeadline ?? "—"}</div>
        </div>
      </div>

      {keyDates.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">Key dates</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {keyDates.map((kd, i) => (
              <li key={i} className="flex items-center justify-between">
                <span>{kd.label}</span>
                <span className="text-neutral-500">{kd.date}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scopeSummary.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">Scope</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {scopeSummary.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-neutral-300">•</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {riskFlags.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Risk &amp; compliance flags
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {riskFlags.map((r, i) => (
              <li key={i} className="flex gap-2 text-amber-900">
                <span>⚠</span>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

const STAGE_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "CONTACTED", label: "Contacted" },
  { value: "QUALIFIED", label: "Qualified" },
  { value: "ESTIMATING", label: "Estimating" },
  { value: "WON", label: "Won" },
  { value: "LOST", label: "Lost" },
];

function StageChip({ stage }: { stage: string }) {
  switch (stage) {
    case "WON":
      return <StatusChip tone="good">Won</StatusChip>;
    case "LOST":
      return <StatusChip tone="critical">Lost</StatusChip>;
    case "ESTIMATING":
      return <StatusChip tone="info">Estimating</StatusChip>;
    case "NEW":
      return <StatusChip tone="neutral">New</StatusChip>;
    default:
      return <StatusChip tone="warning">{stage.charAt(0) + stage.slice(1).toLowerCase()}</StatusChip>;
  }
}

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

  const [companies, users, contacts, documents] = await Promise.all([
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.contact.findMany({
      where: { deletedAt: null, companyId: opportunity.companyId },
      orderBy: { name: "asc" },
    }),
    listDocuments(opportunity.id),
  ]);

  const updateWithId = updateOpportunity.bind(null, opportunity.id);
  const deleteWithId = deleteOpportunity.bind(null, opportunity.id);
  const changeStageWithId = changeStage.bind(null, opportunity.id);
  const convertWithId = convertToEstimate.bind(null, opportunity.id);
  const convertToProjectWithId = convertToProject.bind(null, opportunity.id);
  const uploadDocumentWithId = uploadDocumentAction.bind(null, opportunity.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        backHref="/opportunities"
        backLabel="Opportunities"
        title={
          <>
            {opportunity.showName}
            <StageChip stage={opportunity.stage} />
          </>
        }
        action={<LinkButton href={`/opportunities/${opportunity.id}/chat`} variant="secondary">Chat</LinkButton>}
      />

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
        <ConfirmForm
          action={deleteWithId}
          confirmMessage="Delete this opportunity? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete opportunity</Button>
        </ConfirmForm>
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

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Documents
        </h2>
        <p className="mb-4 text-sm text-neutral-500">
          RFP packages, scope of work, drawings, contracts — anything client-supplied. Uploaded
          documents can seed draft estimate line items and answer questions in chat.
        </p>
        {documents.length === 0 ? (
          <p className="mb-4 text-sm text-neutral-500">No documents uploaded yet.</p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2 text-sm">
            {documents.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 rounded-md bg-neutral-50 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <a
                    href={`/opportunities/${opportunity.id}/documents/${doc.id}`}
                    className="truncate font-medium text-neutral-900 hover:underline"
                  >
                    {doc.filename}
                  </a>
                  <span className="shrink-0 text-neutral-400">
                    {fmtBytes(doc.sizeBytes)} · {doc.uploadedBy?.name ?? "Unknown"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ExtractionStatusChip status={doc.extractionStatus} />
                  {(doc.extractionStatus === "PENDING" || doc.extractionStatus === "FAILED") && (
                    <form action={analyzeDocumentAction.bind(null, opportunity.id, doc.id)}>
                      <button type="submit" className="text-xs text-neutral-500 hover:underline">
                        Analyze
                      </button>
                    </form>
                  )}
                  <ConfirmForm
                    action={deleteDocumentAction.bind(null, opportunity.id, doc.id)}
                    confirmMessage={`Delete "${doc.filename}"? This can't be undone.`}
                  >
                    <button type="submit" className="text-neutral-400 hover:text-red-600" aria-label={`Delete ${doc.filename}`}>
                      ✕
                    </button>
                  </ConfirmForm>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form action={uploadDocumentWithId} className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="file" className="text-sm font-medium text-neutral-700">
              File <span className="text-red-500">*</span>
            </label>
            <input
              id="file"
              name="file"
              type="file"
              required
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm outline-none file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-2 file:py-1 file:text-sm"
            />
          </div>
          <SelectField label="Type" name="documentType" defaultValue="OTHER" options={DOCUMENT_TYPE_OPTIONS} />
          <Button>Upload</Button>
        </form>
      </Card>

      <ProjectBriefCard documents={documents} />

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
