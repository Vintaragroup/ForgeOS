// Finds LineItems already committed into the WRONG project's Estimate,
// within a multi-project Opportunity (2+ named Estimates). Distinct from
// estimate-synthesis-service.ts's buildEstimateFromAllDocuments, which
// only ever prevents new contamination going forward (see its own
// notOtherProject filter) -- it never inspects rows that are already
// committed. Nothing else in the app does either: re-analyzing a document
// only rewrites that Document row, never touches LineItems already
// created from it (see document-summary-service.ts's summarizeDocument).
//
// Purely deterministic DB comparison, no AI calls -- safe to compute on
// every Opportunity page load. Two signals, most confident first:
//
// 1. The source Document is manually tagged to a specific project
//    (Document.estimateId) that disagrees with which Estimate the
//    LineItem is actually sitting in. This is the realistic case: a
//    document gets retagged (see assignDocumentEstimate,
//    document-service.ts) AFTER its line items were already committed --
//    that function nulls the document's proposedLineItems cache (it's
//    stale under the new tag) but never touches the LineItems already
//    created from the old tag, so they're silently left behind in the
//    wrong estimate with no other trace.
// 2. The source Document is shared/untagged, but its cached AI per-item
//    classification (still on Document.proposedLineItems, since
//    commitScopeLineItems never writes back to it) disagrees with where
//    the item landed. Matched by verbatim sourceQuote + description --
//    both are passed through unchanged from proposal to commit.
//
// A LineItem with no documentId (manually added) or where the
// correlation trail is gone (the cache was nulled by a later retag)
// produces no finding either way -- there's no signal to check it
// against, and reporting "looks fine" would be a false clearance.

import { db } from "@/lib/db";
import { getProjectContext } from "@/lib/ai/scope-document-context";
import type { ProposedLineItem } from "@/lib/ai/scope-line-item-service";

export interface MisattributedLineItem {
  lineItemId: string;
  description: string;
  sourceQuote: string | null;
  documentFilename: string;
  currentEstimateId: string;
  currentEstimateName: string;
  correctEstimateId: string;
  correctEstimateName: string;
  reason: "document-tag-mismatch" | "ai-classification-mismatch";
}

export async function findMisattributedLineItems(opportunityId: string): Promise<MisattributedLineItem[]> {
  const context = await getProjectContext(opportunityId);
  if (context.estimates.length === 0) return [];

  const estimateNameById = new Map(context.estimates.map((e) => [e.id, e.name]));

  const estimates = await db.estimate.findMany({
    where: { id: { in: context.estimates.map((e) => e.id) } },
    include: {
      versions: {
        where: { isCurrent: true },
        include: {
          sections: {
            where: { optionId: null },
            include: { lineItems: { where: { documentId: { not: null } } } },
          },
        },
      },
    },
  });

  const documentIds = new Set<string>();
  for (const est of estimates) {
    for (const version of est.versions) {
      for (const section of version.sections) {
        for (const li of section.lineItems) {
          if (li.documentId) documentIds.add(li.documentId);
        }
      }
    }
  }
  const documents = await db.document.findMany({ where: { id: { in: [...documentIds] } } });
  const documentById = new Map(documents.map((d) => [d.id, d]));

  const findings: MisattributedLineItem[] = [];

  for (const est of estimates) {
    for (const version of est.versions) {
      for (const section of version.sections) {
        for (const li of section.lineItems) {
          if (!li.documentId) continue;
          const doc = documentById.get(li.documentId);
          if (!doc) continue;

          if (doc.estimateId && doc.estimateId !== est.id) {
            findings.push({
              lineItemId: li.id,
              description: li.description,
              sourceQuote: li.sourceQuote,
              documentFilename: doc.filename,
              currentEstimateId: est.id,
              currentEstimateName: est.name ?? "Unnamed estimate",
              correctEstimateId: doc.estimateId,
              correctEstimateName: estimateNameById.get(doc.estimateId) ?? "Unknown estimate",
              reason: "document-tag-mismatch",
            });
            continue;
          }

          if (!doc.estimateId && doc.proposedLineItems) {
            const proposed = (doc.proposedLineItems as unknown as ProposedLineItem[]) ?? [];
            const match = proposed.find(
              (p) => p.sourceQuote === li.sourceQuote && p.description === li.description,
            );
            if (match?.estimateId && match.estimateId !== est.id) {
              findings.push({
                lineItemId: li.id,
                description: li.description,
                sourceQuote: li.sourceQuote,
                documentFilename: doc.filename,
                currentEstimateId: est.id,
                currentEstimateName: est.name ?? "Unnamed estimate",
                correctEstimateId: match.estimateId,
                correctEstimateName: estimateNameById.get(match.estimateId) ?? "Unknown estimate",
                reason: "ai-classification-mismatch",
              });
            }
          }
        }
      }
    }
  }

  return findings;
}
