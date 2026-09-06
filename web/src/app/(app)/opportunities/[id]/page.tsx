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
  updateTimelineMilestoneAction,
} from "../actions";
import { buildEstimateFromDocumentsAction, convertToEstimate, convertToProject } from "../convert-actions";
import {
  analyzeDocumentAction,
  assignDocumentEstimateAction,
  deleteDocumentAction,
  finalizeDocumentUploadAction,
  updateDocumentTypeAction,
} from "./documents/actions";
import { regenerateTimelineAction, runClarificationQuestionsAnalysisAction } from "./ai-actions";
import { getTimelineData, buildEmptyMilestones, type TimelineData } from "@/lib/timeline-service";
import { TimelineMilestoneRow } from "@/components/timeline-milestone-row";
import { money } from "@/lib/money";
import { formatOpportunityLabel } from "@/lib/opportunity-name";
import { deleteMisattributedLineItemAction, moveLineItemToEstimateAction } from "./line-item-audit-actions";
import { findMisattributedLineItems, type MisattributedLineItem } from "@/lib/line-item-audit-service";
import type { ClarificationQuestion } from "@/lib/ai/clarification-questions-service";
import { listDocuments } from "@/lib/document-service";
import { getCitableLineItems, getCitableQuotes, getThreadMessages } from "@/lib/chat-service";
import {
  EXTRACTABLE_OPPORTUNITY_FIELDS,
  type DocumentSummary,
  type ExtractableOpportunityField,
} from "@/lib/ai/document-summary-service";
import { citationHref, linkifyMentions, parseFreeTextDate } from "@/lib/citation";
import { XLSX_MIME } from "@/lib/ai/text-extraction";
import { taxRateLabel, taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import {
  buildDealChecklist,
  daysInStage,
  STAGE_AGE_CRITICAL_DAYS,
  STAGE_AGE_WARNING_DAYS,
} from "@/lib/deal-checklist";
import { Button, CollapsibleSection, Field, PageHeader, ReadOnlyField, SelectField, StatusBanner, StatusChip } from "@/components/ui";
import { readStatus } from "@/lib/action-status";
import { ConfirmForm } from "@/components/confirm-form";
import { ChatWidget } from "@/components/chat-widget";
import { DocumentUploadForm } from "@/components/document-upload-form";
import { SubmitButton } from "@/components/submit-button";
import { ProjectTypeFields, ProjectTypeFieldsView } from "@/components/project-type-fields";
import { OpportunityNamePreview } from "@/components/opportunity-name-preview";
import { CLOSE_REASON_LABELS, StageChangeFields } from "@/components/stage-change-fields";

const DOCUMENT_TYPE_OPTIONS = [
  { value: "RFP", label: "RFP" },
  { value: "SCOPE_OF_WORK", label: "Scope of work" },
  { value: "PRICING_SCHEDULE", label: "Pricing schedule" },
  { value: "DRAWING", label: "Drawing / CAD export" },
  { value: "CONTRACT", label: "Contract" },
  { value: "SCHEDULE", label: "Schedule" },
  { value: "MEETING_NOTES", label: "Meeting notes / transcript" },
  { value: "VENDOR_QUOTE", label: "Vendor quote" },
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

// Single source of truth for "what should this row's retag control default
// to" -- used to be two separate suggestion sources (the spreadsheet check
// and the AI one) each rendering their own hint text plus their own
// one-click form next to the always-present generic retag dropdown, so a
// document with an AI suggestion showed two different ways to do the same
// retag at once. The spreadsheet check wins when both could apply (it's a
// deterministic mime-type fact, not a model guess, and in practice rarely
// overlaps with getSuggestedRetag anyway since a mistagged spreadsheet
// usually never reaches COMPLETE in the first place).
function getSuggestedDocumentType(doc: {
  mimeType: string;
  documentType: string;
  extractionStatus: string;
  extractedSummary: unknown;
}): { type: string; reason: string } | null {
  if (isLikelyMistaggedSpreadsheet(doc)) {
    return {
      type: "PRICING_SCHEDULE",
      reason:
        "This is a spreadsheet file, but it's not tagged as Pricing Schedule -- it won't get parsed for real qty/unit-cost rows this way.",
    };
  }
  const aiSuggested = getSuggestedRetag(doc);
  if (aiSuggested) {
    return { type: aiSuggested, reason: "Suggested from this document's own analyzed content." };
  }
  return null;
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
// historical document just to read it without a blank line. estimateId
// carried through (not dropped) so multi-project grouping below can use
// it -- undefined/missing (an older summary, or a single-project
// Opportunity) means shared/unclassified, same convention as everywhere
// else this field is read.
function normalizeCitedText(
  item: unknown,
): { text: string; sourceQuote: string; pageNumber: number | null; estimateId?: string | null } {
  if (typeof item === "string") return { text: item, sourceQuote: "", pageNumber: null };
  return item as { text: string; sourceQuote: string; pageNumber: number | null; estimateId?: string | null };
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
  namedEstimates,
  defaultOpen,
}: {
  opportunityId: string;
  documents: { id: string; filename: string; mimeType: string; extractionStatus: string; extractedSummary: unknown }[];
  // Empty for the common single-project Opportunity -- the whole card
  // renders exactly as it did before this field existed. 2+ entries
  // split every section below into one sub-section per project plus a
  // "Shared / General" catch-all, using each item's own estimateId (see
  // document-summary-service.ts's resolution).
  namedEstimates: { id: string; name: string }[];
  defaultOpen: boolean;
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
  const allKeyDates = analyzed
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

  const allScopeSummary = analyzed.flatMap((d) =>
    d.extractedSummary.scopeSummary.map((s) => ({ ...normalizeCitedText(s), doc: d })),
  );
  const allRiskFlags = analyzed.flatMap((d) =>
    d.extractedSummary.riskFlags.map((r) => ({ ...normalizeCitedText(r), doc: d })),
  );

  const isMultiProject = namedEstimates.length >= 2;
  interface Bucket {
    key: string;
    label: string | null;
    keyDates: typeof allKeyDates;
    scopeSummary: typeof allScopeSummary;
    riskFlags: typeof allRiskFlags;
  }
  const buckets: Bucket[] = isMultiProject
    ? [
        ...namedEstimates.map((e) => ({
          key: e.id,
          label: e.name,
          keyDates: allKeyDates.filter((kd) => kd.estimateId === e.id),
          scopeSummary: allScopeSummary.filter((s) => s.estimateId === e.id),
          riskFlags: allRiskFlags.filter((r) => r.estimateId === e.id),
        })),
        {
          key: "shared",
          label: "Shared / General",
          keyDates: allKeyDates.filter((kd) => kd.estimateId == null),
          scopeSummary: allScopeSummary.filter((s) => s.estimateId == null),
          riskFlags: allRiskFlags.filter((r) => r.estimateId == null),
        },
      ].filter((b) => b.keyDates.length + b.scopeSummary.length + b.riskFlags.length > 0)
    : [{ key: "all", label: null, keyDates: allKeyDates, scopeSummary: allScopeSummary, riskFlags: allRiskFlags }];

  return (
    <CollapsibleSection title="Project brief" id="project-brief" defaultOpen={defaultOpen}>
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

      {buckets.map((bucket, bucketIndex) => {
        const idPrefix = bucket.key === "all" ? "" : `${bucket.key}-`;
        const keyDateGroups = KEY_DATE_GROUPS.map((group) => ({
          ...group,
          items: bucket.keyDates.filter((kd) => (kd.dateType ?? "MILESTONE") === group.dateType),
        })).filter((group) => group.items.length > 0);

        return (
          <div
            key={bucket.key}
            className={isMultiProject && bucketIndex > 0 ? "mt-6 border-t border-neutral-200 pt-4" : undefined}
          >
            {bucket.label && <h3 className="mb-3 text-sm font-semibold text-neutral-700">{bucket.label}</h3>}

            {keyDateGroups.length > 0 && (
              <div className="mb-4">
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">Key dates</h4>
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
                            id={`key-date-${idPrefix}${group.dateType}-${i}`}
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
                                `/opportunities/${opportunityId}#key-date-${idPrefix}${group.dateType}-${i}`,
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

            {bucket.scopeSummary.length > 0 && (
              <div className="mb-4">
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">Scope</h4>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {bucket.scopeSummary.map((s, i) => (
                    <li key={i} id={`scope-summary-${idPrefix}${i}`} className="flex items-start justify-between gap-3">
                      <span className="flex gap-2">
                        <span className="text-neutral-300">•</span>
                        <span>{s.text}</span>
                      </span>
                      <CitationLink
                        href={citationHref(
                          opportunityId,
                          s.doc,
                          s,
                          `/opportunities/${opportunityId}#scope-summary-${idPrefix}${i}`,
                        )}
                        source={s.doc.filename}
                        page={s.pageNumber}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {bucket.riskFlags.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Risk &amp; compliance flags
                </h4>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {bucket.riskFlags.map((r, i) => (
                    <li
                      key={i}
                      id={`brief-risk-flag-${idPrefix}${i}`}
                      className="flex items-start justify-between gap-3 text-amber-900"
                    >
                      <span className="flex gap-2">
                        <span>⚠</span>
                        <span>{r.text}</span>
                      </span>
                      <CitationLink
                        href={citationHref(
                          opportunityId,
                          r.doc,
                          r,
                          `/opportunities/${opportunityId}#brief-risk-flag-${idPrefix}${i}`,
                        )}
                        source={r.doc.filename}
                        page={r.pageNumber}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </CollapsibleSection>
  );
}

const TIMELINE_DATE_FORMAT: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

// Every proposal needs this fixed 11-milestone checklist -- see
// timeline-service.ts's CANONICAL_MILESTONES. Always shows all 11 rows,
// even before a Timeline has ever been generated, so the checklist itself
// (not just its populated rows) is visible from the start; a row without a
// confirmed date is flagged, matching the "every proposal needs this"
// requirement.
function TimelineCard({
  opportunityId,
  timelineData,
  documents,
  defaultOpen,
}: {
  opportunityId: string;
  timelineData: TimelineData | null;
  documents: { id: string; filename: string; mimeType: string }[];
  defaultOpen: boolean;
}) {
  const milestones = timelineData?.milestones ?? buildEmptyMilestones();
  const regenerateWithId = regenerateTimelineAction.bind(null, opportunityId);

  return (
    <CollapsibleSection title="Timeline" id="timeline" defaultOpen={defaultOpen}>
      <p className="mb-4 text-sm text-neutral-500">
        The standard project schedule for every proposal -- deposit, artwork deadline, install, and everything in
        between. Auto-populated where possible from onboarding details and scope documents; edit any row directly,
        or Regenerate to re-run extraction (hand-edited rows are never overwritten by a re-run).
      </p>
      <form action={regenerateWithId}>
        <SubmitButton pendingText={timelineData ? "Re-generating…" : "Generating…"} variant="secondary">
          {timelineData ? "Re-generate timeline" : "Generate timeline"}
        </SubmitButton>
      </form>

      {timelineData && (
        <p className="mb-3 mt-4 text-xs text-neutral-400">
          Generated {new Date(timelineData.generatedAt).toLocaleString()} — re-run after onboarding details or
          documents change.
        </p>
      )}

      <table className="mt-4 w-full text-left">
        <thead>
          <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
            <th className="py-1.5 pr-2 font-normal">Milestone</th>
            <th className="py-1.5 pr-2 font-normal">Date</th>
            <th className="py-1.5 pr-2 font-normal">Responsible</th>
            <th className="py-1.5 pl-2 font-normal" />
          </tr>
        </thead>
        <tbody>
          {milestones.map((m) => {
            const doc = m.documentId ? documents.find((d) => d.id === m.documentId) : undefined;
            const href =
              doc && m.sourceQuote
                ? citationHref(opportunityId, doc, { sourceQuote: m.sourceQuote, pageNumber: m.pageNumber ?? null })
                : null;
            const conflictDoc = m.conflict ? documents.find((d) => d.id === m.conflict!.documentId) : undefined;
            const conflictHref = conflictDoc
              ? citationHref(opportunityId, conflictDoc, {
                  sourceQuote: m.conflict!.sourceQuote,
                  pageNumber: m.conflict!.pageNumber,
                })
              : null;
            return (
              <TimelineMilestoneRow
                key={m.type}
                label={m.label}
                displayDate={m.date ? new Date(m.date).toLocaleDateString("en-US", TIMELINE_DATE_FORMAT) : null}
                rawDate={m.date ? new Date(m.date).toISOString().slice(0, 10) : ""}
                responsibleParty={m.responsibleParty}
                source={m.source}
                confirmed={m.confirmed}
                citationHref={href}
                citationLabel={doc ? doc.filename : null}
                conflictDisplayDate={
                  m.conflict ? new Date(m.conflict.date).toLocaleDateString("en-US", TIMELINE_DATE_FORMAT) : null
                }
                conflictCitationHref={conflictHref}
                conflictCitationLabel={conflictDoc ? conflictDoc.filename : null}
                updateAction={updateTimelineMilestoneAction.bind(null, opportunityId, m.type)}
              />
            );
          })}
        </tbody>
      </table>
    </CollapsibleSection>
  );
}

// Only rendered when findMisattributedLineItems (line-item-audit-
// service.ts) found something -- invisible for every opportunity with no
// findings, same gating as every other multi-project card on this page.
// The target estimate is already known from whichever signal flagged the
// row, so "Move" is a single button, not a picker.
function LineItemAuditCard({
  opportunityId,
  findings,
}: {
  opportunityId: string;
  findings: MisattributedLineItem[];
}) {
  if (findings.length === 0) return null;

  return (
    <CollapsibleSection title={`Line items to review (${findings.length})`}>
      <p className="mb-4 text-sm text-neutral-500">
        These line items were committed into an estimate that no longer matches their source
        document&apos;s project — most often because a document was retagged to a different project
        after its items were already committed. Move each to the estimate it actually belongs to, or
        delete it if it&apos;s not needed.
      </p>
      <ul className="flex flex-col gap-3 text-sm">
        {findings.map((f) => (
          <li key={f.lineItemId} className="flex items-start justify-between gap-3 rounded border border-amber-200 bg-amber-50 p-3">
            <div>
              <div className="font-medium">{f.description}</div>
              {f.sourceQuote && <div className="mt-0.5 text-xs italic text-neutral-500">&ldquo;{f.sourceQuote}&rdquo;</div>}
              <div className="mt-1 text-xs text-neutral-500">
                From {f.documentFilename} — currently in <strong>{f.currentEstimateName}</strong>, belongs in{" "}
                <strong>{f.correctEstimateName}</strong>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <form action={moveLineItemToEstimateAction.bind(null, opportunityId, f.lineItemId, f.correctEstimateId)}>
                <button type="submit" className="text-xs font-medium text-blue-600 hover:underline">
                  Move to {f.correctEstimateName}
                </button>
              </form>
              <ConfirmForm
                action={deleteMisattributedLineItemAction.bind(null, opportunityId, f.lineItemId)}
                confirmMessage={`Delete "${f.description}"? This can't be undone.`}
              >
                <button type="submit" className="text-xs text-neutral-400 hover:text-red-600">
                  Delete
                </button>
              </ConfirmForm>
            </div>
          </li>
        ))}
      </ul>
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
  const searchParams = await props.searchParams;
  const {
    editDetails: editDetailsParam,
    collaboratorsUpdated: collaboratorsUpdatedParam,
    ask: askParam,
    open: openParam,
  } = searchParams;
  // Which collapsed-by-default section (if any) a link elsewhere on the
  // page should land already expanded in -- native <details> only
  // auto-expands an ancestor when the linked #id targets content NESTED
  // inside it, not when the #id is the <details> element's own root (the
  // case for every section-level "Go →" link the Deal Checklist produces).
  // Same query-param-drives-server-render convention as editDetails/
  // collaboratorsUpdated above, just generic across every section that
  // needs it instead of one boolean per section.
  const openSection = Array.isArray(openParam) ? openParam[0] : openParam;
  // Set by the dashboard's router (routeDashboardQueryAction) when it
  // matched your typed text to this exact opportunity -- see ChatWidget's
  // own autoOpen/initialInput comment for why this only pre-fills the
  // input rather than sending on your behalf.
  const ask = Array.isArray(askParam) ? askParam[0] : askParam;
  const { success: statusSuccess, error: statusError } = readStatus(searchParams);
  // Same query-param toggle convention as estimates/[id]/page.tsx's
  // importDocumentId/proposeDocumentId -- a plain server-rendered view
  // vs. edit split needs no client state, just which panel a link
  // navigates to. Details defaults to the read-only view (matching "this
  // should be information that's been entered, with an edit button");
  // updateOpportunity's own redirect back to the bare /opportunities/[id]
  // URL after Save is what returns here to view mode, no extra code
  // needed for that half of the round trip.
  const isEditingDetails = (Array.isArray(editDetailsParam) ? editDetailsParam[0] : editDetailsParam) === "1";
  const collaboratorsUpdated =
    (Array.isArray(collaboratorsUpdatedParam) ? collaboratorsUpdatedParam[0] : collaboratorsUpdatedParam) === "1";
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const opportunity = await db.opportunity.findFirst({
    where: { id, deletedAt: null },
    include: {
      company: true,
      // Excludes archivedAt too, not just deletedAt -- was missing this
      // filter entirely before, so an archived estimate (and everything
      // derived from this list below: estimateId, namedEstimates,
      // currentEstimateVersion) never actually disappeared from here.
      // Archived estimates get their own separate query/section below.
      estimates: {
        where: { deletedAt: null, archivedAt: null },
        orderBy: { createdAt: "desc" },
        include: {
          taxRate: true,
          // Only the current version, and only its proposals -- the Deal
          // Checklist card below (buildDealChecklist) only ever needs
          // "where does the LATEST version of the LATEST estimate
          // actually stand," not full version/proposal history.
          versions: {
            where: { isCurrent: true },
            take: 1,
            include: { proposals: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } } },
          },
        },
      },
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

  // Separate from the active `opportunity.estimates` list above -- kept
  // out of that include (and everything derived from it) so an archived
  // estimate never counts as "the" estimate for this Opportunity, but
  // still surfaced here so it stays reachable for reference (see the
  // Estimates card's own "Archived estimates" sub-section below).
  const archivedEstimates = await db.estimate.findMany({
    where: { opportunityId: opportunity.id, deletedAt: null, archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
  });

  // A Pricing Schedule document never goes through Analyze -- it's parsed
  // directly on the Estimate page's Import panel instead (see
  // ExtractionStatusChip below). Without a link there, retagging a
  // document to Pricing Schedule looked like a dead end: no Analyze
  // button appears for it here, and nothing pointed at where its real
  // next step actually lives.
  const estimateId = opportunity.estimates[0]?.id;
  // Same 2+ named Estimates threshold scope-document-context.ts's
  // getProjectContext uses -- multi-project UI (per-document assignment,
  // grouped Project Brief/Clarification Questions) only appears once
  // this is genuinely non-empty, so a single-estimate Opportunity (the
  // common case) sees no extra UI at all.
  const namedEstimates = opportunity.estimates.filter(
    (e): e is typeof e & { name: string } => e.name !== null && e.name !== "",
  );
  const isMultiProject = namedEstimates.length >= 2;

  const [companies, users, contacts, documents, chatMessages, citableLineItems, citableQuotes, taxRates, misattributedLineItems] =
    await Promise.all([
      db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
      db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
      db.contact.findMany({
        where: { deletedAt: null, companyId: opportunity.companyId },
        orderBy: { name: "asc" },
      }),
      listDocuments(opportunity.id),
      getThreadMessages(opportunity.id),
      getCitableLineItems(opportunity.id),
      getCitableQuotes(opportunity.id),
      db.taxRate.findMany(TAX_RATE_PICKER_QUERY),
      // Zero-cost for the common single-project Opportunity -- returns []
      // immediately without a query (see findMisattributedLineItems).
      isMultiProject ? findMisattributedLineItems(opportunity.id) : Promise.resolve([] as MisattributedLineItem[]),
    ]);

  const updateWithId = updateOpportunity.bind(null, opportunity.id);
  const deleteWithId = deleteOpportunity.bind(null, opportunity.id);
  const changeStageWithId = changeStage.bind(null, opportunity.id);
  const updateCollaboratorsWithId = updateCollaborators.bind(null, opportunity.id);
  const collaboratorIds = new Set(opportunity.collaborators.map((c) => c.userId));
  const convertWithId = convertToEstimate.bind(null, opportunity.id);
  const convertToProjectWithId = convertToProject.bind(null, opportunity.id);
  const pricingScheduleDoc = documents.find((d) => d.documentType === "PRICING_SCHEDULE");
  const buildEstimateWithIds = pricingScheduleDoc
    ? buildEstimateFromDocumentsAction.bind(null, opportunity.id, pricingScheduleDoc.id)
    : null;

  // Same document-eligibility rule as clarification-questions-service.ts's
  // getScopeDocuments (scope-document-context.ts) -- only pricing
  // schedules are excluded now; DRAWING and MEETING_NOTES both produce
  // real scopeSummary/candidateGaps bullets just like a text document.
  const hasScopeDocuments = documents.some(
    (d) => d.extractionStatus === "COMPLETE" && d.documentType !== "PRICING_SCHEDULE",
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
  // Same bucketing shape as ProjectBriefCard -- one section per named
  // Estimate plus a "Shared / General" catch-all, only once 2+ Estimates
  // exist. A question's estimateId is inherited from its source
  // candidate, already resolved at Analyze time (see clarification-
  // questions-service.ts) -- no new classification happens here.
  interface ClarificationBucket {
    key: string;
    label: string | null;
    recommended: typeof recommendedQuestions;
    worthReviewing: typeof worthReviewingQuestions;
  }
  const clarificationBuckets: ClarificationBucket[] = isMultiProject
    ? [
        ...namedEstimates.map((e) => ({
          key: e.id,
          label: e.name,
          recommended: recommendedQuestions.filter((q) => q.estimateId === e.id),
          worthReviewing: worthReviewingQuestions.filter((q) => q.estimateId === e.id),
        })),
        {
          key: "shared",
          label: "Shared / General",
          recommended: recommendedQuestions.filter((q) => q.estimateId == null),
          worthReviewing: worthReviewingQuestions.filter((q) => q.estimateId == null),
        },
      ].filter((b) => b.recommended.length + b.worthReviewing.length > 0)
    : [{ key: "all", label: null, recommended: recommendedQuestions, worthReviewing: worthReviewingQuestions }];
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

  // "What's next to close this deal" -- entirely derived from data this
  // page already fetched for other cards (documents, the current estimate
  // version, its proposals), so this adds no new query and can never go
  // stale. See deal-checklist.ts for the actual step-by-step logic.
  const currentEstimateVersion = opportunity.estimates[0]?.versions[0] ?? null;
  // At-a-glance header strip -- contact/owner/estimate value are all
  // several sections down (Details, Estimates) otherwise, so opening the
  // record from a list gives no orientation without scrolling. Summed
  // across every active estimate (not just the most recent) rather than
  // showing one project's number as if it were the whole deal's -- the
  // common single-estimate case is just a sum of one. headerContactName/
  // headerOwnerName are also reused by the Details card's own read-only
  // view below -- same lookup, computed once.
  const headerContactName = contacts.find((c) => c.id === opportunity.primaryContactId)?.name ?? null;
  const headerOwnerName = users.find((u) => u.id === opportunity.ownerId)?.name ?? null;
  const headerEstimateTotals = opportunity.estimates
    .map((e) => e.versions[0]?.grandTotal)
    .filter((v): v is NonNullable<typeof v> => v != null);
  const headerEstimateValue =
    headerEstimateTotals.length > 0 ? headerEstimateTotals.reduce((sum, v) => sum + Number(v), 0) : null;
  // Computed once here and reused by TimelineCard below -- same JSON blob,
  // no reason to re-parse it a second time.
  const timelineData = getTimelineData(opportunity.timelineMilestones);
  const missingTimelineMilestoneCount = (timelineData?.milestones ?? buildEmptyMilestones()).filter(
    (m) => !m.date,
  ).length;
  const dealChecklist = buildDealChecklist({
    opportunityId: opportunity.id,
    stage: opportunity.stage,
    primaryContactId: opportunity.primaryContactId,
    ownerId: opportunity.ownerId,
    pendingFieldSuggestionCount: getFieldSuggestions(opportunity, documents).length,
    documentsNeedingAnalysisCount: documents.filter(
      (d) => d.documentType !== "PRICING_SCHEDULE" && (d.extractionStatus === "PENDING" || d.extractionStatus === "FAILED"),
    ).length,
    hasScopeDocuments,
    recommendedClarificationQuestionCount: recommendedQuestions.length,
    bidderQuestionsDeadlineLabel: bidderQuestionsDeadline?.date ?? null,
    missingTimelineMilestoneCount,
    estimateId: estimateId ?? null,
    currentVersion: currentEstimateVersion
      ? { isLocked: currentEstimateVersion.isLocked, isApproved: currentEstimateVersion.isApproved }
      : null,
    currentVersionProposals: currentEstimateVersion?.proposals ?? [],
    projectCount: opportunity.projects.length,
  });
  // Most recent stage change, falling back to the opportunity's own
  // creation -- stageEvents is already fetched ordered changedAt desc.
  const stageAgeDays = ["WON", "LOST"].includes(opportunity.stage)
    ? null
    : daysInStage(opportunity.stageEvents[0]?.changedAt ?? opportunity.createdAt);

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

  const hasHeaderSummary = headerContactName || headerOwnerName || headerEstimateValue !== null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <PageHeader
          backHref="/opportunities"
          backLabel="Opportunities"
          title={
            <>
              {opportunity.showName}
              <StageChip stage={opportunity.stage} />
              {stageAgeDays !== null && stageAgeDays >= STAGE_AGE_WARNING_DAYS && (
                <StatusChip tone={stageAgeDays >= STAGE_AGE_CRITICAL_DAYS ? "critical" : "warning"}>
                  {stageAgeDays} days in stage
                </StatusChip>
              )}
            </>
          }
          // Moved out of the Details card -- it used to sit at the bottom of
          // a long edit form, separated from routine field edits by nothing
          // but a border, which is not where a destructive, irreversible
          // action belongs. The confirm dialog (ConfirmForm) is unchanged.
          action={
            <ConfirmForm action={deleteWithId} confirmMessage="Delete this opportunity? This can't be undone.">
              <Button variant="danger">Delete opportunity</Button>
            </ConfirmForm>
          }
        />
        {hasHeaderSummary && (
          <div className="-mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-500">
            <span>
              <span className="text-neutral-400">Contact:</span> {headerContactName ?? "—"}
            </span>
            <span>
              <span className="text-neutral-400">Owner:</span> {headerOwnerName ?? "—"}
            </span>
            {headerEstimateValue !== null && (
              <span>
                <span className="text-neutral-400">
                  {isMultiProject ? "Estimated total (all projects):" : "Estimate:"}
                </span>{" "}
                {money(headerEstimateValue)}
              </span>
            )}
          </div>
        )}
      </div>

      {statusSuccess && <StatusBanner kind="success">{statusSuccess}</StatusBanner>}
      {statusError && <StatusBanner kind="error">{statusError}</StatusBanner>}

      {dealChecklist.length > 0 && (
        <CollapsibleSection title="Next steps to close this deal">
          <ul className="flex flex-col gap-2 text-sm">
            {dealChecklist.map((item) => (
              <li
                key={item.id}
                className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 ${
                  item.urgent ? "bg-red-50" : "bg-neutral-50"
                }`}
              >
                <span className={item.urgent ? "text-red-800" : "text-neutral-800"}>{item.label}</span>
                <Link href={item.href} className="shrink-0 text-xs font-medium text-brand-navy hover:underline">
                  Go →
                </Link>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Stage">
        <form action={changeStageWithId} className="flex flex-wrap items-end gap-3">
          <StageChangeFields key={opportunity.stage} defaultStage={opportunity.stage} />
          <Button>Update stage</Button>
        </form>
        {(opportunity.stage === "WON" || opportunity.stage === "LOST") && opportunity.closeReason && (
          <p className="mt-4 text-sm text-neutral-600">
            <span className="font-medium">Closed reason:</span> {CLOSE_REASON_LABELS[opportunity.closeReason]}
            {opportunity.closeReasonDetail ? ` — ${opportunity.closeReasonDetail}` : ""}
          </p>
        )}
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

      <CollapsibleSection title="Details" id="details">
        {isEditingDetails ? (
          <>
            <form action={updateWithId} className="flex flex-col gap-4">
              <SelectField
                label="Company"
                name="companyId"
                defaultValue={opportunity.companyId}
                required
                options={companies.map((c) => ({ value: c.id, label: c.name }))}
              />
              <Field label="Show name" name="showName" defaultValue={opportunity.showName} required />
              <OpportunityNamePreview companies={companies.map((c) => ({ id: c.id, name: c.name }))} />
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
              <div className="flex gap-3">
                <Button>Save changes</Button>
                <Link
                  href={`/opportunities/${opportunity.id}`}
                  className="inline-flex items-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                >
                  Cancel
                </Link>
              </div>
            </form>
            <OpportunityFieldSuggestions opportunityId={opportunity.id} opportunity={opportunity} documents={documents} />
          </>
        ) : (
          <>
            <div className="flex flex-col gap-4">
              <ReadOnlyField label="Company" value={opportunity.company.name} />
              <ReadOnlyField label="Show name" value={opportunity.showName} />
              <ReadOnlyField
                label="Naming convention"
                value={formatOpportunityLabel({
                  companyName: opportunity.company.name,
                  showName: opportunity.showName,
                  eventStartDate: opportunity.eventStartDate,
                  boothNumber: opportunity.boothNumber,
                })}
              />
              <ProjectTypeFieldsView
                values={{
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
                <ReadOnlyField label="Target move-in" value={fmtDate(opportunity.targetMoveIn)} />
                <ReadOnlyField label="Target move-out" value={fmtDate(opportunity.targetMoveOut)} />
              </div>
              <ReadOnlyField label="Primary contact" value={headerContactName} />
              <ReadOnlyField label="Owner" value={headerOwnerName} />
              <ReadOnlyField
                label="Tax jurisdiction"
                value={(() => {
                  const matchedTaxRate = taxRates.find((t) => t.id === opportunity.taxRateId);
                  return matchedTaxRate ? taxRateOptionLabel(matchedTaxRate) : undefined;
                })()}
              />
              <div>
                <Link
                  href={`/opportunities/${opportunity.id}?editDetails=1`}
                  className="inline-flex items-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                >
                  Edit
                </Link>
              </div>
            </div>
            <OpportunityFieldSuggestions opportunityId={opportunity.id} opportunity={opportunity} documents={documents} />
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Estimates" id="estimates">
        {opportunity.estimates.length === 0 ? (
          <p className="mb-4 text-sm text-neutral-500">
            No estimate started yet. Converting pre-fills job details from this opportunity.
          </p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2 text-sm">
            {opportunity.estimates.map((e) => (
              <li key={e.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                <span>
                  {e.name ?? `Estimate ${e.id.slice(0, 8)}`} — {e.status}
                  {e.taxRate ? ` · ${taxRateLabel(e.taxRate)}` : ""}
                </span>
                <Link href={`/estimates/${e.id}`} className="text-neutral-900 hover:underline">
                  Open estimate →
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <form action={convertWithId} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56">
              <Field
                label="Name (optional)"
                name="name"
                placeholder={
                  opportunity.estimates.length > 0
                    ? "e.g. Full Swing PGA -- separate exhibit, same client"
                    : undefined
                }
              />
            </div>
            <Button variant="secondary">Convert to estimate</Button>
          </form>
          {buildEstimateWithIds && (
            <form action={buildEstimateWithIds}>
              <SubmitButton pendingText="Building…" variant="primary">
                Build estimate from &quot;{pricingScheduleDoc!.filename}&quot;
              </SubmitButton>
            </form>
          )}
        </div>
        {archivedEstimates.length > 0 && (
          <CollapsibleSection title={`Archived estimates (${archivedEstimates.length})`} defaultOpen={false} className="mt-4">
            <ul className="flex flex-col gap-2 text-sm">
              {archivedEstimates.map((e) => (
                <li key={e.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                  <span>
                    {e.name ?? `Estimate ${e.id.slice(0, 8)}`} — archived {e.archivedAt!.toLocaleDateString()}
                  </span>
                  <Link href={`/estimates/${e.id}`} className="text-neutral-900 hover:underline">
                    Open estimate →
                  </Link>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Documents" id="documents" defaultOpen={openSection === "documents"}>
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
                  {isMultiProject && (
                    <form
                      action={assignDocumentEstimateAction.bind(null, opportunity.id, doc.id)}
                      className="flex items-center gap-1"
                    >
                      <select
                        name="estimateId"
                        defaultValue={doc.estimateId ?? ""}
                        title="Which project this document is about -- left as 'AI classifies' for a document that discusses more than one (e.g. a meeting transcript)."
                        className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 outline-none focus:border-neutral-500"
                      >
                        <option value="">— AI classifies —</option>
                        {namedEstimates.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className="text-xs text-brand-navy hover:underline">
                        Set
                      </button>
                    </form>
                  )}
                  {doc.documentType === "PRICING_SCHEDULE" && estimateId && (
                    <Link href={`/estimates/${estimateId}`} className="text-xs text-brand-navy hover:underline">
                      Import on Estimate page →
                    </Link>
                  )}
                  {isLowYieldDrawingResult(doc) && (
                    <span
                      className="text-xs text-amber-600"
                      title="Fewer than 3 facts found across the analyzed pages -- for a drawing, that's often a bad extraction rather than a truly bare sheet. Consider Re-analyze."
                    >
                      Sparse result
                    </span>
                  )}
                  {/* One retag control per document, always present (except
                      Pricing Schedule, which has its own dedicated import
                      flow) -- pre-selects a suggested type when one exists
                      (getSuggestedDocumentType) instead of showing a second,
                      separate one-click form next to it. A document stuck at
                      UNSUPPORTED (e.g. a PNG uploaded as anything other than
                      Drawing -- see text-extraction.ts) has no suggestion but
                      still gets this control, which is what gives it any
                      retag path at all. updateDocumentType resets
                      extractionStatus back to PENDING on any retag, which is
                      what makes the Analyze button reappear afterward. */}
                  {doc.documentType !== "PRICING_SCHEDULE" &&
                    (() => {
                      const suggestion = getSuggestedDocumentType(doc);
                      const suggestedLabel = suggestion
                        ? (DOCUMENT_TYPE_OPTIONS.find((o) => o.value === suggestion.type)?.label ?? suggestion.type)
                        : null;
                      return (
                        <form
                          action={updateDocumentTypeAction.bind(null, opportunity.id, doc.id)}
                          className="flex items-center gap-1"
                        >
                          {suggestion && (
                            <span className="text-xs text-amber-600" title={suggestion.reason}>
                              Suggested: {suggestedLabel}
                            </span>
                          )}
                          <select
                            name="documentType"
                            defaultValue={suggestion?.type ?? doc.documentType}
                            aria-label={`Change document type for ${doc.filename}`}
                            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 outline-none focus:border-neutral-500"
                          >
                            {DOCUMENT_TYPE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="text-xs text-neutral-500 hover:underline">
                            Retag
                          </button>
                        </form>
                      );
                    })()}
                  {doc.documentType !== "PRICING_SCHEDULE" &&
                    (doc.extractionStatus === "PENDING" || doc.extractionStatus === "FAILED") && (
                      <form action={analyzeDocumentAction.bind(null, opportunity.id, doc.id)}>
                        <SubmitButton pendingText="Analyzing…" className="text-xs text-neutral-500 hover:underline">
                          Analyze
                        </SubmitButton>
                      </form>
                    )}
                  {doc.documentType !== "PRICING_SCHEDULE" &&
                    doc.extractionStatus === "COMPLETE" && (
                      <form action={analyzeDocumentAction.bind(null, opportunity.id, doc.id)}>
                        <SubmitButton
                          pendingText="Re-analyzing…"
                          className="text-xs text-neutral-400 hover:underline"
                        >
                          <span title="Re-run analysis -- picks up any improvements since this document was last analyzed">
                            Re-analyze
                          </span>
                        </SubmitButton>
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
        <DocumentUploadForm
          opportunityId={opportunity.id}
          finalizeUpload={finalizeDocumentUploadAction}
          documentTypeOptions={DOCUMENT_TYPE_OPTIONS}
        />
      </CollapsibleSection>

      <ProjectBriefCard
        opportunityId={opportunity.id}
        documents={documents}
        namedEstimates={namedEstimates}
        defaultOpen={openSection === "project-brief"}
      />

      <TimelineCard
        opportunityId={opportunity.id}
        timelineData={timelineData}
        documents={documents}
        defaultOpen={openSection === "timeline"}
      />

      <LineItemAuditCard opportunityId={opportunity.id} findings={misattributedLineItems} />

      {hasScopeDocuments && (
        <CollapsibleSection
          title="Clarification questions"
          id="clarification-questions"
          defaultOpen={openSection === "clarification-questions"}
        >
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
            <SubmitButton
              pendingText={clarificationQuestions ? "Re-generating…" : "Generating…"}
              variant="secondary"
            >
              {clarificationQuestions ? "Re-generate clarification questions" : "Generate clarification questions"}
            </SubmitButton>
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
                clarificationBuckets.map((bucket, bucketIndex) => (
                  <div
                    key={bucket.key}
                    className={isMultiProject && bucketIndex > 0 ? "mt-6 border-t border-neutral-200 pt-4" : undefined}
                  >
                    {bucket.label && <h3 className="mb-3 text-sm font-semibold text-neutral-700">{bucket.label}</h3>}
                    {bucket.recommended.length > 0 && (
                      <ul className="flex flex-col gap-3 text-sm">
                        {bucket.recommended.map((q, i) =>
                          renderClarificationQuestion(q, `clarification-question-recommended-${bucket.key}-${i}`, "amber"),
                        )}
                      </ul>
                    )}
                    {bucket.worthReviewing.length > 0 && (
                      <div className={bucket.recommended.length > 0 ? "mt-4" : undefined}>
                        <p className="mb-2 text-xs text-neutral-500">
                          Worth reviewing — plausible, but less certain than the above. Use your own judgment on
                          whether these are worth sending.
                        </p>
                        <ul className="flex flex-col gap-3 text-sm">
                          {bucket.worthReviewing.map((q, i) =>
                            renderClarificationQuestion(q, `clarification-question-review-${bucket.key}-${i}`, "neutral"),
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </CollapsibleSection>
      )}

      {opportunity.stage === "WON" && (
        <CollapsibleSection title="Project" id="project">
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

      <CollapsibleSection title="Collaborators" id="collaborators" defaultOpen={collaboratorsUpdated}>
        <p className="mb-4 text-sm text-neutral-500">
          Registered teammates checked below can see and work on this opportunity, in addition to its
          owner. Admins can already see every opportunity regardless of this list.
        </p>
        {collaboratorsUpdated && <StatusBanner kind="success">Collaborators updated.</StatusBanner>}
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
          content: linkifyMentions(m.content, opportunity.id, documents, citableLineItems, citableQuotes),
        }))}
        autoOpen={!!ask}
        initialInput={ask ?? ""}
      />
    </div>
  );
}
