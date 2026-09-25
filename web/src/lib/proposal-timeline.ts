// Cover-page content for the proposal PDF: dated milestones, venue, and a
// short project description -- see historical Expo CCI proposals in
// data/historical_jobs/pdf, which all lead with a TIMELINE section plus a
// hand-written scope paragraph before any pricing appears.
//
// The timeline itself is sourced from Opportunity.timelineMilestones (see
// timeline-service.ts) -- the estimator-reviewed, canonical 11-milestone
// checklist, not WorkOrder (a Project-scoped, post-award model normally
// empty during proposal drafting). Only entries with a confirmed, non-null
// date make it onto a client-facing PDF; a milestone still flagged missing
// simply doesn't render a row rather than showing a blank/TBD one.

import { db } from "@/lib/db";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { isStaleSource } from "@/lib/document-validity";
import { getTimelineData } from "@/lib/timeline-service";
import type { TimelineResponsibleParty } from "@/generated/prisma/enums";

export interface ProposalTimelineEntry {
  label: string;
  date: Date;
  responsibleParty: TimelineResponsibleParty;
}

export interface ProposalCoverInfo {
  timeline: ProposalTimelineEntry[];
  venue: string | null;
  scopeSummary: string[];
}

const MAX_SCOPE_SUMMARY_ITEMS = 8;

export async function getProposalCoverInfo(opportunityId: string): Promise<ProposalCoverInfo> {
  const [opportunity, documents] = await Promise.all([
    db.opportunity.findUniqueOrThrow({
      where: { id: opportunityId },
      select: { timelineMilestones: true },
    }),
    db.document.findMany({
      where: { deletedAt: null, extractionStatus: "COMPLETE", opportunityId },
      // Newest first, so when two documents both name a venue the more
      // recent one wins. It used to be whatever order the database
      // returned, which is no way to choose what a client reads.
      orderBy: { createdAt: "desc" },
      select: { id: true, validity: true, supersedesId: true, extractedSummary: true },
    }),
  ]);

  // A document that is no longer the authority for anything must not be
  // writing the client's Project Description.
  //
  // This read took every completed extraction on the opportunity and
  // asked nothing about validity, so Full Swing's proposal opened with
  // "Rental of LED screens and monitors for the event" -- straight out of
  // the Fuse AV quote, which was withdrawn when Fuse came off the job.
  // The estimating lead's review of the proposal listed it first, along
  // with "I think we remove all references to LED".
  //
  // SUPERSEDED is derived from the revision chain here the same way
  // document-validity.ts derives it everywhere else: a document something
  // else supersedes is stale whatever its own column says.
  const supersededIds = new Set(
    documents.map((d) => d.supersedesId).filter((id): id is string => id !== null),
  );
  const currentDocuments = documents.filter(
    (d) =>
      !isStaleSource({
        validity: d.validity,
        supersededByFilename: supersededIds.has(d.id) ? "superseded" : null,
      }),
  );

  const timelineData = getTimelineData(opportunity.timelineMilestones);
  const timeline: ProposalTimelineEntry[] = (timelineData?.milestones ?? [])
    .filter((m) => m.date !== null)
    .map((m) => ({ label: m.label, date: new Date(m.date!), responsibleParty: m.responsibleParty }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  let venue: string | null = null;
  const scopeSeen = new Set<string>();
  const scopeSummary: string[] = [];

  for (const doc of currentDocuments) {
    if (!doc.extractedSummary) continue;
    const summary = doc.extractedSummary as unknown as DocumentSummary;

    if (!venue && summary.venue) venue = summary.venue;
    for (const item of summary.scopeSummary) {
      const text = item.text.trim();
      if (!text || scopeSeen.has(text)) continue;
      scopeSeen.add(text);
      scopeSummary.push(text);
    }
  }

  return { timeline, venue, scopeSummary: scopeSummary.slice(0, MAX_SCOPE_SUMMARY_ITEMS) };
}
