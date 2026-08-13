import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import {
  applyOpportunityFieldSuggestionAction,
  changeStage,
  deleteOpportunity,
  updateCollaborators,
  updateOpportunity,
} from "../actions";
import { buildEstimateFromDocumentsAction, convertToEstimate, convertToProject } from "../convert-actions";
import { analyzeDocumentAction, deleteDocumentAction, updateDocumentTypeAction, uploadDocumentAction } from "./documents/actions";
import { runClarificationQuestionsAnalysisAction } from "./ai-actions";
import type { ClarificationQuestion } from "@/lib/ai/clarification-questions-service";
import { listDocuments } from "@/lib/document-service";
import { getThreadMessages } from "@/lib/chat-service";
import {
  EXTRACTABLE_OPPORTUNITY_FIELDS,
  type DocumentSummary,
  type ExtractableOpportunityField,
} from "@/lib/ai/document-summary-service";
import { citationHref, linkifyDocumentMentions, parseFreeTextDate } from "@/lib/citation";
import { XLSX_MIME } from "@/lib/ai/text-extraction";
import { taxRateLabel, taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import { Button, CollapsibleSection, Field, PageHeader, SelectField, StatusChip } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";
import { ChatWidget } from "@/components/chat-widget";
import { DocumentUploadForm } from "@/components/document-upload-form";
import { ProjectTypeFields } from "@/components/project-type-fields";

const DOCUMENT_TYPE_OPTIONS = [
  { value: "RFP", label: "RFP" },
  { value: "SCOPE_OF_WORK", label: "Scope of work" },
  { value: "PRICING_SCHEDULE", label: "Pricing schedule" },
  { value: "DRAWING", label: "Drawing / CAD export" },
  { value: "CONTRACT", label: "Contract" },
  { value: "SCHEDULE", label: "Schedule" },
  { value: "OTHER", label: "Other" },
];

// PRICING_SCHEDULE never goes through the AI summarizer at all (see
// text-extraction.ts) -- shown as its own fixed, non-alarming label
// rather than routing through PENDING/UNSUPPORTED, so a document that
// was never going to be "analyzed" doesn't read like one that failed to
// be. DRAWING used to be the same case but now goes through the vision
// summarizer (analyze-document.ts / drawing-summary-service.ts), so it
// falls through to the normal status switch below like any other type.
function ExtractionStatusChip({ status, documentType }: { status: string; documentType: string }) {
  if (documentType === "PRICING_SCHEDULE") {
    return <StatusChip tone="info">Priced via import</StatusChip>;
  }
  switch (status) {
    case "COMPLETE":
      return <StatusChip tone="good">Analyzed</StatusChip>;
    case "PROCESSING":
      return <StatusChip tone="info">Analyzing…</StatusChip>;
    case "FAILED":
      return <StatusChip tone="critical">Analysis failed</StatusChip>;
    case "UNSUPPORTED":
      return <StatusChip tone="neutral">Not analyzable</StatusChip>;
    default:
      return <StatusChip tone="neutral">Not analyzed</StatusChip>;
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A near-empty result on a multi-page DRAWING extraction is far more
// often a bad vision-call run than a truly bare drawing (confirmed live:
// a real 11-page CAD PDF found 6 facts on one run and ~0-1 on a re-run of
// the same pages) -- surfaced as a hint next to the status chip, derived
// from the already-stored extractedSummary at render time, no new
// ExtractionStatus or persisted field.
function isLowYieldDrawingResult(doc: {
  documentType: string;
  extractionStatus: string;
  extractedSummary: unknown;
}): boolean {
  if (doc.documentType !== "DRAWING" || doc.extractionStatus !== "COMPLETE" || !doc.extractedSummary) return false;
  const summary = doc.extractedSummary as DocumentSummary;
  return summary.scopeSummary.length + summary.riskFlags.length < 3;
}

// The AI already reads every text document's full content once at Analyze
// time -- suggestedDocumentType (document-summary-service.ts) piggybacks
// on that same call to flag when a document's content doesn't match how
// it's currently filed, instead of only catching the narrow XLSX case
// below. Caught two real mistags on a real test job this way: a Vendor
// Services Agreement and a Scope of Work spec, both uploaded as generic
// "RFP".
function getSuggestedRetag(doc: {
  documentType: string;
  extractionStatus: string;
  extractedSummary: unknown;
}): string | null {
  if (doc.extractionStatus !== "COMPLETE" || !doc.extractedSummary) return null;
  const summary = doc.extractedSummary as DocumentSummary;
  const suggested = summary.suggestedDocumentType;
  if (!suggested || suggested === doc.documentType) return null;
  return suggested;
}

// Caught a real test job's Financial Proposal Schedule .xlsx tagged as
// RFP instead of Pricing Schedule -- it went through the generic text
// summarizer (which doesn't know how to read spreadsheets) instead of
// pricing-import-service.ts's deterministic XLSX parser, came back
// UNSUPPORTED, and its real qty/unit-cost rows never made it into the
// estimate at all. A spreadsheet mime type is unambiguous regardless of
// how it's tagged, so this is a cheap, reliable catch -- not a heuristic.
function isLikelyMistaggedSpreadsheet(doc: { mimeType: string; documentType: string }): boolean {
  return doc.mimeType === XLSX_MIME && doc.documentType !== "PRICING_SCHEDULE";
}

function CitationLink({
  href,
  source,
  page,
}: {
  href: string | null;
  source: string;
  page: number | null;
}) {
  const label = page ? `${source}, p.${page}` : source;
  if (!href) {
    return <span className="shrink-0 text-xs text-neutral-400">{source}</span>;
  }
  return (
    <Link href={href} className="shrink-0 text-xs text-brand-navy hover:underline">
      {label} →
    </Link>
  );
}

// Documents analyzed before scope/risk items carried their own citation
// (sourceQuote/pageNumber) stored these as plain strings -- normalize old
// and new shapes together rather than forcing a re-analysis of every
// historical document just to read it without a blank line.
function normalizeCitedText(item: unknown): { text: string; sourceQuote: string; pageNumber: number | null } {
  if (typeof item === "string") return { text: item, sourceQuote: "", pageNumber: null };
  return item as { text: string; sourceQuote: string; pageNumber: number | null };
}

const KEY_DATE_GROUPS: { dateType: "DEADLINE" | "MILESTONE" | "INFORMATIONAL"; label: string; className: string }[] = [
  { dateType: "DEADLINE", label: "Deadlines", className: "text-amber-900" },
  { dateType: "MILESTONE", label: "Milestones", className: "text-brand-navy" },
  { dateType: "INFORMATIONAL", label: "FYI", className: "text-neutral-400" },
];

// Merged at read time from every analyzed document, not stored as its own
// aggregate -- consistent with the rest of this app computing rollups
// live (e.g. admin-analytics.ts) rather than caching a stale summary.
function ProjectBriefCard({
  opportunityId,
  documents,
}: {
  opportunityId: string;
  documents: { id: string; filename: string; mimeType: string; extractionStatus: string; extractedSummary: unknown }[];
}) {
  const analyzed = documents.filter(
    (d) => d.extractionStatus === "COMPLETE" && d.extractedSummary,
  ) as { id: string; filename: string; mimeType: string; extractionStatus: string; extractedSummary: DocumentSummary }[];

  if (analyzed.length === 0) return null;

  const eventOrProjectName = analyzed.map((d) => d.extractedSummary.eventOrProjectName).find(Boolean);
  const venue = analyzed.map((d) => d.extractedSummary.venue).find(Boolean);
  const submissionDeadline = analyzed.map((d) => d.extractedSummary.submissionDeadline).find(Boolean);

  // Two documents from the same RFP package routinely restate the same
  // fact -- same problem the Dashboard already solves (dashboard.ts),
  // deduped here the same way: by label + parsed date, first occurrence
  // wins. Sorted chronologically after, since documents rarely list their
  // own dates in date order, let alone two documents combined.
  const seenKeyDates = new Set<string>();
  const keyDates = analyzed
    .flatMap((d) => d.extractedSummary.keyDates.map((kd) => ({ ...kd, doc: d })))
    .filter((kd) => {
      const parsed = parseFreeTextDate(kd.date);
      const dedupeKey = `${kd.label.trim().toLowerCase()}::${parsed ? parsed.toISOString().slice(0, 10) : kd.date}`;
      if (seenKeyDates.has(dedupeKey)) return false;
      seenKeyDates.add(dedupeKey);
      return true;
    })
    .sort((a, b) => {
      const dateA = parseFreeTextDate(a.date);
      const dateB = parseFreeTextDate(b.date);
      if (!dateA && !dateB) return 0;
      if (!dateA) return 1;
      if (!dateB) return -1;
      return dateA.getTime() - dateB.getTime();
    });
  const keyDateGroups = KEY_DATE_GROUPS.map((group) => ({
    ...group,
    items: keyDates.filter((kd) => (kd.dateType ?? "MILESTONE") === group.dateType),
  })).filter((group) => group.items.length > 0);

  const scopeSummary = analyzed.flatMap((d) =>
    d.extractedSummary.scopeSummary.map((s) => ({ ...normalizeCitedText(s), doc: d })),
  );
  const riskFlags = analyzed.flatMap((d) =>
    d.extractedSummary.riskFlags.map((r) => ({ ...normalizeCitedText(r), doc: d })),
  );

  return (
    <CollapsibleSection title="Project brief">
      <p className="mb-4 text-sm text-neutral-500">
        Extracted from {analyzed.length} analyzed document{analyzed.length === 1 ? "" : "s"} — click a citation
        to jump to where it came from; verify against the source before relying on it.
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

      {keyDateGroups.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">Key dates</h3>
          <div className="flex flex-col gap-3">
            {keyDateGroups.map((group) => (
              <div key={group.dateType}>
                <div className={`mb-1 text-xs font-semibold ${group.className}`}>
                  {group.label} <span className="font-normal text-neutral-400">({group.items.length})</span>
                </div>
                <ul className="flex flex-col gap-1 text-sm">
                  {group.items.map((kd, i) => (
                    <li
                      key={i}
                      id={`key-date-${group.dateType}-${i}`}
                      className="flex items-center justify-between gap-3"
                    >
                      <span>
                        {kd.label} <span className="text-neutral-500">— {kd.date}</span>
                      </span>
                      <CitationLink
                        href={citationHref(
                          opportunityId,
                          kd.doc,
                          kd,
                          `/opportunities/${opportunityId}#key-date-${group.dateType}-${i}`,
                        )}
                        source={kd.doc.filename}
                        page={kd.pageNumber}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {scopeSummary.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">Scope</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {scopeSummary.map((s, i) => (
              <li key={i} id={`scope-summary-${i}`} className="flex items-start justify-between gap-3">
                <span className="flex gap-2">
                  <span className="text-neutral-300">•</span>
                  <span>{s.text}</span>
                </span>
                <CitationLink
                  href={citationHref(opportunityId, s.doc, s, `/opportunities/${opportunityId}#scope-summary-${i}`)}
                  source={s.doc.filename}
                  page={s.pageNumber}
                />
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
          <ul className="flex flex-col gap-1.5 text-sm">
            {riskFlags.map((r, i) => (
              <li key={i} id={`brief-risk-flag-${i}`} className="flex items-start justify-between gap-3 text-amber-900">
                <span className="flex gap-2">
                  <span>⚠</span>
                  <span>{r.text}</span>
                </span>
                <CitationLink
                  href={citationHref(opportunityId, r.doc, r, `/opportunities/${opportunityId}#brief-risk-flag-${i}`)}
                  source={r.doc.filename}
                  page={r.pageNumber}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </CollapsibleSection>
  );
}

const EXTRACTABLE_FIELD_LABELS: Record<ExtractableOpportunityField, string> = {
  boothNumber: "Booth number",
  boothSize: "Booth size",
  shipDate: "Ship date",
  eventStartDate: "Event start date",
  eventEndDate: "Event end date",
  siteAddress: "Site address",
};

const EXTRACTABLE_DATE_FIELDS = new Set<ExtractableOpportunityField>(["shipDate", "eventStartDate", "eventEndDate"]);

function fmtSuggestionDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// A suggestion only shows when it would actually change something -- a
// field the opportunity already has set to the same value (accepted last
// time, or entered manually and it happens to match) doesn't need to
// nag. Same "propose once, never silently apply" contract as
// getSuggestedRetag above, just for onboarding fields instead of document
// type.
function getFieldSuggestions(
  opportunity: {
    boothNumber: string | null;
    boothSize: string | null;
    shipDate: Date | null;
    eventStartDate: Date | null;
    eventEndDate: Date | null;
    siteAddress: string | null;
  },
  documents: { id: string; filename: string; mimeType: string; extractionStatus: string; extractedSummary: unknown }[],
) {
  const analyzed = documents.filter(
    (d) => d.extractionStatus === "COMPLETE" && d.extractedSummary,
  ) as { id: string; filename: string; mimeType: string; extractionStatus: string; extractedSummary: DocumentSummary }[];

  const suggestions: {
    field: ExtractableOpportunityField;
    label: string;
    value: string;
    doc: (typeof analyzed)[number];
    sourceQuote: string;
    pageNumber: number | null;
  }[] = [];

  for (const field of EXTRACTABLE_OPPORTUNITY_FIELDS) {
    const found = analyzed
      .flatMap((d) => (d.extractedSummary.extractedFields ?? []).map((ef) => ({ ...ef, doc: d })))
      .find((ef) => ef.field === field && ef.value.trim() !== "");
    if (!found) continue;

    if (EXTRACTABLE_DATE_FIELDS.has(field)) {
      const parsed = parseFreeTextDate(found.value);
      if (!parsed) continue; // nothing a human could meaningfully accept
      const current = field === "shipDate" ? opportunity.shipDate
        : field === "eventStartDate" ? opportunity.eventStartDate
        : opportunity.eventEndDate;
      if (current && fmtSuggestionDate(current) === fmtSuggestionDate(parsed)) continue;
    } else {
      const current = field === "boothNumber" ? opportunity.boothNumber
        : field === "boothSize" ? opportunity.boothSize
        : opportunity.siteAddress;
      if (current && current.trim() === found.value.trim()) continue;
    }

    suggestions.push({
      field,
      label: EXTRACTABLE_FIELD_LABELS[field],
      value: found.value,
      doc: found.doc,
      sourceQuote: found.sourceQuote,
      pageNumber: found.pageNumber,
    });
  }

  return suggestions;
}

function OpportunityFieldSuggestions({
  opportunityId,
  opportunity,
  documents,
}: {
  opportunityId: string;
  opportunity: {
    boothNumber: string | null;
    boothSize: string | null;
    shipDate: Date | null;
    eventStartDate: Date | null;
    eventEndDate: Date | null;
    siteAddress: string | null;
  };
  documents: { id: string; filename: string; mimeType: string; extractionStatus: string; extractedSummary: unknown }[];
}) {
  const suggestions = getFieldSuggestions(opportunity, documents);
  if (suggestions.length === 0) return null;

  return (
    <div className="mt-4 border-t border-neutral-200 pt-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Suggested from documents
      </h3>
      <ul className="flex flex-col gap-2">
        {suggestions.map((s) => (
          <li
            key={s.field}
            id={`suggested-field-${s.field}`}
            className="flex items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm"
          >
            <span>
              <span className="font-medium text-amber-900">{s.label}:</span>{" "}
              <span className="text-amber-900">{s.value}</span>{" "}
              <CitationLink
                href={citationHref(
                  opportunityId,
                  s.doc,
                  s,
                  `/opportunities/${opportunityId}#suggested-field-${s.field}`,
                )}
                source={s.doc.filename}
                page={s.pageNumber}
              />
            </span>
            <form action={applyOpportunityFieldSuggestionAction.bind(null, opportunityId, s.field)}>
              <input type="hidden" name="value" value={s.value} />
              <button type="submit" className="shrink-0 text-xs font-medium text-brand-navy hover:underline">
                Accept
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
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
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const opportunity = await db.opportunity.findFirst({
    where: { id, deletedAt: null },
    include: {
      company: true,
      estimates: { orderBy: { createdAt: "desc" }, include: { taxRate: true } },
      projects: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
      stageEvents: { orderBy: { changedAt: "desc" } },
      collaborators: { select: { userId: true } },
    },
  });
  if (!opportunity) notFound();
  // Same failure mode as "doesn't exist" -- 404, not a distinguishable
  // 403, so an unauthorized request can't tell the difference between
  // "no such opportunity" and "exists but you can't see it."
  if (!(await canAccessOpportunity(user, opportunity.id))) notFound();

  // A Pricing Schedule document never goes through Analyze -- it's parsed
  // directly on the Estimate page's Import panel instead (see
  // ExtractionStatusChip below). Without a link there, retagging a
  // document to Pricing Schedule looked like a dead end: no Analyze
  // button appears for it here, and nothing pointed at where its real
  // next step actually lives.
  const estimateId = opportunity.estimates[0]?.id;

  const [companies, users, contacts, documents, chatMessages, taxRates] = await Promise.all([
    db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.contact.findMany({
      where: { deletedAt: null, companyId: opportunity.companyId },
      orderBy: { name: "asc" },
    }),
    listDocuments(opportunity.id),
    getThreadMessages(opportunity.id),
    db.taxRate.findMany(TAX_RATE_PICKER_QUERY),
  ]);

  const updateWithId = updateOpportunity.bind(null, opportunity.id);
  const deleteWithId = deleteOpportunity.bind(null, opportunity.id);
  const changeStageWithId = changeStage.bind(null, opportunity.id);
  const updateCollaboratorsWithId = updateCollaborators.bind(null, opportunity.id);
  const collaboratorIds = new Set(opportunity.collaborators.map((c) => c.userId));
  const convertWithId = convertToEstimate.bind(null, opportunity.id);
  const convertToProjectWithId = convertToProject.bind(null, opportunity.id);
  const uploadDocumentWithId = uploadDocumentAction.bind(null, opportunity.id);
  const pricingScheduleDoc = documents.find((d) => d.documentType === "PRICING_SCHEDULE");
  const buildEstimateWithIds = pricingScheduleDoc
    ? buildEstimateFromDocumentsAction.bind(null, opportunity.id, pricingScheduleDoc.id)
    : null;

  // Same document-eligibility rule as clarification-questions-service.ts's
  // getScopeDocuments (scope-document-context.ts) -- pricing schedules and
  // drawings never have real scope text to review.
  const hasScopeDocuments = documents.some(
    (d) => d.extractionStatus === "COMPLETE" && !["PRICING_SCHEDULE", "DRAWING"].includes(d.documentType),
  );
  const runClarificationQuestionsWithId = runClarificationQuestionsAnalysisAction.bind(null, opportunity.id);
  const clarificationQuestions = opportunity.clarificationQuestions as unknown as {
    generatedAt: string;
    questions: ClarificationQuestion[];
  } | null;
  // Resolves each question's documentId back to a real Document for
  // citationHref + filename display -- clarificationQuestions only stores
  // the id, not the full document. Dropped silently if that document was
  // since deleted.
  const clarificationQuestionsWithDocs = clarificationQuestions
    ? clarificationQuestions.questions.flatMap((q) => {
        const doc = documents.find((d) => d.id === q.documentId);
        return doc ? [{ ...q, doc }] : [];
      })
    : [];
  // Split, not filtered -- a single AI pass silently dropping every
  // candidate it wasn't fully confident about turned out to be the real
  // bug (see clarification-questions-service.ts's own comment): about
  // half of what got dropped in a real audit was genuinely worth a
  // human's look, not noise. WORTH_REVIEWING candidates are still shown,
  // just in a clearly secondary section -- the estimator, who has real
  // contract context the model doesn't, makes the final call instead of
  // a single unsupervised model guess.
  const recommendedQuestions = clarificationQuestionsWithDocs.filter((q) => q.confidence === "RECOMMENDED");
  const worthReviewingQuestions = clarificationQuestionsWithDocs.filter((q) => q.confidence !== "RECOMMENDED");
  // Best-effort: surfaces the submission-questions deadline next to the
  // trigger button without duplicating ProjectBriefCard's own (more
  // complete) key-date extraction below -- dateType has no distinct
  // "bidder questions" value (see document-summary-service.ts), so this
  // matches on label text within the DEADLINE group, same as a human
  // scanning the list would.
  const analyzedForDeadline = documents.filter(
    (d) => d.extractionStatus === "COMPLETE" && d.extractedSummary,
  ) as unknown as { extractedSummary: DocumentSummary }[];
  const bidderQuestionsDeadline = analyzedForDeadline
    .flatMap((d) => d.extractedSummary.keyDates)
    .find((kd) => (kd.dateType ?? "MILESTONE") === "DEADLINE" && /question/i.test(kd.label));

  // Shared between the recommended and worth-reviewing lists below --
  // same row shape, only the color/emphasis differs by section, not the
  // structure, so it's one function rather than two near-duplicate maps.
  // opportunityId captured as a local, not read as opportunity.id inside
  // the closure below -- TS narrowing from the earlier `if (!opportunity)
  // notFound()` guard doesn't cross into a nested function body.
  const opportunityId = opportunity.id;
  function renderClarificationQuestion(
    q: (typeof clarificationQuestionsWithDocs)[number],
    idPrefix: string,
    tone: "amber" | "neutral",
  ) {
    const href = citationHref(opportunityId, q.doc, q, `/opportunities/${opportunityId}#${idPrefix}`);
    const bg = tone === "amber" ? "bg-amber-50" : "bg-neutral-50";
    const text = tone === "amber" ? "text-amber-900" : "text-neutral-800";
    const subtext = tone === "amber" ? "text-amber-700" : "text-neutral-500";
    return (
      <li key={idPrefix} id={idPrefix} className={`flex flex-col gap-1 rounded-md ${bg} px-3 py-2`}>
        <div className="flex items-start justify-between gap-3">
          <span className={text}>{q.question}</span>
          {href ? (
            <Link href={href} className="shrink-0 text-xs text-brand-navy hover:underline">
              {q.doc.filename} →
            </Link>
          ) : (
            <span className="shrink-0 text-xs text-neutral-400">{q.doc.filename}</span>
          )}
        </div>
        <span className={`text-xs ${subtext}`}>Why: {q.rationale}</span>
      </li>
    );
  }

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
      />

      <CollapsibleSection title="Stage">
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
      </CollapsibleSection>

      <CollapsibleSection title="Details">
        <form action={updateWithId} className="flex flex-col gap-4">
          <SelectField
            label="Company"
            name="companyId"
            defaultValue={opportunity.companyId}
            required
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Field label="Show name" name="showName" defaultValue={opportunity.showName} required />
          <ProjectTypeFields
            defaults={{
              projectType: opportunity.projectType,
              boothNumber: opportunity.boothNumber ?? "",
              boothSize: opportunity.boothSize ?? "",
              boothSpace: opportunity.boothSpace ?? "",
              boothType: opportunity.boothType ?? "",
              shipDate: fmtDate(opportunity.shipDate),
              venue: opportunity.venue ?? "",
              eventStartDate: fmtDate(opportunity.eventStartDate),
              eventEndDate: fmtDate(opportunity.eventEndDate),
              siteAddress: opportunity.siteAddress ?? "",
              projectDetails: opportunity.projectDetails ?? "",
            }}
          />
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
          <SelectField
            label="Tax jurisdiction"
            name="taxRateId"
            defaultValue={opportunity.taxRateId ?? ""}
            options={[
              { value: "", label: "— none —" },
              ...taxRates.map((t) => ({ value: t.id, label: taxRateOptionLabel(t) })),
            ]}
          />
          <div>
            <Button>Save changes</Button>
          </div>
        </form>
        <OpportunityFieldSuggestions opportunityId={opportunity.id} opportunity={opportunity} documents={documents} />
        <ConfirmForm
          action={deleteWithId}
          confirmMessage="Delete this opportunity? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete opportunity</Button>
        </ConfirmForm>
      </CollapsibleSection>

      <CollapsibleSection title="Estimates">
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
                  {e.taxRate ? ` · ${taxRateLabel(e.taxRate)}` : ""}
                </span>
                <Link href={`/estimates/${e.id}`} className="text-neutral-900 hover:underline">
                  Open estimate →
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-3">
          <form action={convertWithId}>
            <Button variant="secondary">Convert to estimate</Button>
          </form>
          {buildEstimateWithIds && (
            <form action={buildEstimateWithIds}>
              <Button>Build estimate from &quot;{pricingScheduleDoc!.filename}&quot;</Button>
            </form>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Documents">
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
                    href={`/opportunities/${opportunity.id}/documents/${doc.id}/view`}
                    className="truncate font-medium text-neutral-900 hover:underline"
                  >
                    {doc.filename}
                  </a>
                  <span className="shrink-0 text-neutral-400">
                    {fmtBytes(doc.sizeBytes)} · {doc.uploadedBy?.name ?? "Unknown"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ExtractionStatusChip status={doc.extractionStatus} documentType={doc.documentType} />
                  {doc.documentType === "PRICING_SCHEDULE" && estimateId && (
                    <Link href={`/estimates/${estimateId}`} className="text-xs text-brand-navy hover:underline">
                      Import on Estimate page →
                    </Link>
                  )}
                  {isLikelyMistaggedSpreadsheet(doc) && (
                    <>
                      <span
                        className="text-xs text-amber-600"
                        title="This is a spreadsheet file, but it's not tagged as Pricing Schedule -- it won't get parsed for real qty/unit-cost rows this way."
                      >
                        Looks like a Pricing Schedule?
                      </span>
                      <form action={updateDocumentTypeAction.bind(null, opportunity.id, doc.id)} className="flex items-center gap-1">
                        <input type="hidden" name="documentType" value="PRICING_SCHEDULE" />
                        <button type="submit" className="text-xs text-brand-navy hover:underline">
                          Retag as Pricing Schedule
                        </button>
                      </form>
                    </>
                  )}
                  {isLowYieldDrawingResult(doc) && (
                    <span
                      className="text-xs text-amber-600"
                      title="Fewer than 3 facts found across the analyzed pages -- for a drawing, that's often a bad extraction rather than a truly bare sheet. Consider Re-analyze."
                    >
                      Sparse result
                    </span>
                  )}
                  {getSuggestedRetag(doc) &&
                    (() => {
                      const suggested = getSuggestedRetag(doc)!;
                      const label = DOCUMENT_TYPE_OPTIONS.find((o) => o.value === suggested)?.label ?? suggested;
                      return (
                        <>
                          <span className="text-xs text-amber-600" title="Suggested from this document's own analyzed content.">
                            AI suggests: {label}?
                          </span>
                          <form action={updateDocumentTypeAction.bind(null, opportunity.id, doc.id)} className="flex items-center gap-1">
                            <input type="hidden" name="documentType" value={suggested} />
                            <button type="submit" className="text-xs text-brand-navy hover:underline">
                              Retag as {label}
                            </button>
                          </form>
                        </>
                      );
                    })()}
                  {doc.documentType !== "PRICING_SCHEDULE" &&
                    (doc.extractionStatus === "PENDING" || doc.extractionStatus === "FAILED") && (
                      <form action={analyzeDocumentAction.bind(null, opportunity.id, doc.id)}>
                        <button type="submit" className="text-xs text-neutral-500 hover:underline">
                          Analyze
                        </button>
                      </form>
                    )}
                  {doc.documentType !== "PRICING_SCHEDULE" &&
                    doc.extractionStatus === "COMPLETE" && (
                      <form action={analyzeDocumentAction.bind(null, opportunity.id, doc.id)}>
                        <button
                          type="submit"
                          className="text-xs text-neutral-400 hover:underline"
                          title="Re-run analysis -- picks up any improvements since this document was last analyzed"
                        >
                          Re-analyze
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
        <DocumentUploadForm action={uploadDocumentWithId} documentTypeOptions={DOCUMENT_TYPE_OPTIONS} />
      </CollapsibleSection>

      <ProjectBriefCard opportunityId={opportunity.id} documents={documents} />

      {hasScopeDocuments && (
        <CollapsibleSection title="Clarification questions">
          <p className="mb-4 text-sm text-neutral-500">
            Reviews this RFP&apos;s scope documents for genuine ambiguities or gaps worth asking the client
            about — calibrated to a seasoned professional&apos;s judgment, not just anything that looks
            unclear. Read each one before sending; verify against the source.
            {bidderQuestionsDeadline && (
              <>
                {" "}
                Bidder questions are due <strong>{bidderQuestionsDeadline.date}</strong>.
              </>
            )}
          </p>
          <form action={runClarificationQuestionsWithId}>
            <Button variant="secondary">
              {clarificationQuestions ? "Re-generate clarification questions" : "Generate clarification questions"}
            </Button>
          </form>

          {clarificationQuestions && (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <p className="mb-3 text-xs text-neutral-400">
                Generated {new Date(clarificationQuestions.generatedAt).toLocaleString()} — re-run after the
                documents change.
              </p>
              {clarificationQuestionsWithDocs.length === 0 ? (
                <p className="text-sm text-neutral-500">No genuine gaps found — this RFP looks complete.</p>
              ) : (
                <>
                  {recommendedQuestions.length > 0 && (
                    <ul className="flex flex-col gap-3 text-sm">
                      {recommendedQuestions.map((q, i) =>
                        renderClarificationQuestion(q, `clarification-question-recommended-${i}`, "amber"),
                      )}
                    </ul>
                  )}
                  {worthReviewingQuestions.length > 0 && (
                    <div className={recommendedQuestions.length > 0 ? "mt-4" : undefined}>
                      <p className="mb-2 text-xs text-neutral-500">
                        Worth reviewing — plausible, but less certain than the above. Use your own judgment on
                        whether these are worth sending.
                      </p>
                      <ul className="flex flex-col gap-3 text-sm">
                        {worthReviewingQuestions.map((q, i) =>
                          renderClarificationQuestion(q, `clarification-question-review-${i}`, "neutral"),
                        )}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </CollapsibleSection>
      )}

      {opportunity.stage === "WON" && (
        <CollapsibleSection title="Project">
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
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Collaborators" defaultOpen={false}>
        <p className="mb-4 text-sm text-neutral-500">
          Registered teammates checked below can see and work on this opportunity, in addition to its
          owner. Admins can already see every opportunity regardless of this list.
        </p>
        <form action={updateCollaboratorsWithId} className="flex flex-col gap-3">
          {users.length === 0 ? (
            <p className="text-sm text-neutral-400">No other registered users yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {users.map((u) => (
                <li key={u.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`collaborator-${u.id}`}
                    name="collaboratorIds"
                    value={u.id}
                    defaultChecked={collaboratorIds.has(u.id)}
                    disabled={u.id === opportunity.ownerId}
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                  <label htmlFor={`collaborator-${u.id}`}>
                    {u.name}
                    {u.id === opportunity.ownerId && (
                      <span className="ml-1.5 text-xs text-neutral-400">(owner — always has access)</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="secondary">Save collaborators</Button>
          </div>
        </form>
      </CollapsibleSection>

      <ChatWidget
        opportunityId={opportunity.id}
        opportunityName={opportunity.showName}
        initialMessages={chatMessages.map((m) => ({
          id: m.id,
          role: m.role,
          segments: linkifyDocumentMentions(m.content, opportunity.id, documents),
        }))}
      />
    </div>
  );
}
