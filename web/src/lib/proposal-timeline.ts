// Cover-page content for the proposal PDF: dated milestones, venue, and a
// short project description -- see historical Expo CCI proposals in
// data/historical_jobs/pdf, which all lead with a TIMELINE section plus a
// hand-written scope paragraph before any pricing appears. dashboard.ts
// already surfaces the same two date sources (WorkOrder date fields +
// AI-extracted Document.extractedSummary.keyDates) for the "needs
// attention" list, but that view is windowed to +/-30 days and
// cross-opportunity -- a proposal cover page needs every date for one
// opportunity, not just the ones due soon, plus venue/scopeSummary that
// dashboard.ts has no use for.

import { db } from "@/lib/db";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { parseFreeTextDate } from "@/lib/citation";

export interface ProposalTimelineEntry {
  label: string;
  date: Date;
}

export interface ProposalCoverInfo {
  timeline: ProposalTimelineEntry[];
  venue: string | null;
  scopeSummary: string[];
}

const WORK_ORDER_DATE_FIELDS: { field: "depositDueDate" | "productionMeetingDate" | "artworkDeadlineDate" | "balanceDueDate" | "installDate"; label: string }[] = [
  { field: "depositDueDate", label: "Deposit due" },
  { field: "productionMeetingDate", label: "Production meeting" },
  { field: "artworkDeadlineDate", label: "Artwork deadline" },
  { field: "balanceDueDate", label: "Balance due" },
  { field: "installDate", label: "Installation" },
];

const MAX_SCOPE_SUMMARY_ITEMS = 8;

export async function getProposalCoverInfo(opportunityId: string): Promise<ProposalCoverInfo> {
  const [workOrders, documents] = await Promise.all([
    db.workOrder.findMany({
      where: { deletedAt: null, project: { deletedAt: null, opportunityId } },
    }),
    db.document.findMany({
      where: { deletedAt: null, extractionStatus: "COMPLETE", opportunityId },
      select: { extractedSummary: true },
    }),
  ]);

  const timeline: ProposalTimelineEntry[] = [];

  for (const wo of workOrders) {
    for (const { field, label } of WORK_ORDER_DATE_FIELDS) {
      const date = wo[field];
      if (date) timeline.push({ label, date });
    }
  }

  let venue: string | null = null;
  const scopeSeen = new Set<string>();
  const scopeSummary: string[] = [];

  // Same INFORMATIONAL-exclusion and label+date dedupe as dashboard.ts's
  // upcomingDeadlines -- an RFP's narrative PDF and its own Appendix
  // routinely restate the same fact, and INFORMATIONAL dates describe
  // something the client already did (e.g. "RFP Sent"), not a milestone
  // that belongs on a client-facing timeline.
  const dateSeen = new Set<string>();
  for (const doc of documents) {
    if (!doc.extractedSummary) continue;
    const summary = doc.extractedSummary as unknown as DocumentSummary;

    if (!venue && summary.venue) venue = summary.venue;
    for (const item of summary.scopeSummary) {
      const text = item.text.trim();
      if (!text || scopeSeen.has(text)) continue;
      scopeSeen.add(text);
      scopeSummary.push(text);
    }

    for (const kd of summary.keyDates) {
      const dateType = kd.dateType ?? "MILESTONE";
      if (dateType === "INFORMATIONAL") continue;

      const date = parseFreeTextDate(kd.date);
      if (!date) continue;

      const dedupeKey = `${kd.label.trim().toLowerCase()}::${date.toISOString().slice(0, 10)}`;
      if (dateSeen.has(dedupeKey)) continue;
      dateSeen.add(dedupeKey);

      timeline.push({ label: kd.label, date });
    }
  }

  timeline.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { timeline, venue, scopeSummary: scopeSummary.slice(0, MAX_SCOPE_SUMMARY_ITEMS) };
}
