// "Build estimate from documents" -- the one-click alternative to
// picking a document from a dropdown and clicking Propose/Commit one at a
// time (estimates/[id]/page.tsx's Import/Propose panels, still there for
// a single re-run). Runs the same commitPricingImport/
// proposeLineItemsFromScope+commitScopeLineItems logic across every
// eligible document for the Opportunity in one pass, so opening a fresh
// Estimate already reflects everything that's been analyzed instead of
// requiring the estimator to remember which documents still need a click.
//
// Real gap this closes: a real test job had 6 uploaded documents, and its
// estimate only ever reflected 2 of them (whichever ones someone
// remembered to individually Propose+Commit) -- nothing surfaced that the
// other 4 (a mistagged pricing schedule, a mistagged drawing, and one
// analyzed-but-never-proposed scope doc) were sitting there unused.

import { db } from "@/lib/db";
import { commitPricingImport } from "@/lib/pricing-import-service";
import { commitScopeLineItems, proposeLineItemsFromScope } from "@/lib/ai/scope-line-item-service";

export interface BuildEstimateResult {
  imported: { filename: string; kind: "pricing" | "scope"; rowsImported: number }[];
  skipped: { filename: string; reason: string }[];
}

async function alreadyCommitted(estimateVersionId: string, documentId: string): Promise<boolean> {
  const existing = await db.lineItem.findFirst({
    where: { documentId, section: { estimateVersionId, optionId: null } },
  });
  return !!existing;
}

export async function buildEstimateFromAllDocuments(
  estimateVersionId: string,
  opportunityId: string,
  userId: string | null,
): Promise<BuildEstimateResult> {
  const imported: BuildEstimateResult["imported"] = [];
  const skipped: BuildEstimateResult["skipped"] = [];

  // Which real project (Estimate) this run is building for -- documents
  // manually tagged to a DIFFERENT project's estimate are excluded below
  // entirely; untagged/shared documents stay in and get filtered at the
  // item level instead (proposeLineItemsFromScope/commitScopeLineItems).
  // Without this, calling this function for a second Estimate on the same
  // Opportunity reprocessed the exact same document set already used for
  // the first, producing near-identical, cross-project-contaminated
  // results -- a real bug confirmed live against the Full Swing
  // Baseball/PGA Orlando opportunity.
  const { estimateId: targetEstimateId } = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimateId: true },
  });
  const notOtherProject = { OR: [{ estimateId: null }, { estimateId: targetEstimateId }] };

  const pricingDocs = await db.document.findMany({
    where: { opportunityId, deletedAt: null, documentType: "PRICING_SCHEDULE", ...notOtherProject },
    orderBy: { createdAt: "asc" },
  });
  for (const doc of pricingDocs) {
    if (await alreadyCommitted(estimateVersionId, doc.id)) {
      skipped.push({ filename: doc.filename, reason: "Already imported into this estimate." });
      continue;
    }
    try {
      const result = await commitPricingImport(estimateVersionId, doc.id);
      imported.push({ filename: doc.filename, kind: "pricing", rowsImported: result.rowsImported });
    } catch (err) {
      skipped.push({ filename: doc.filename, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Same candidate filter as the Propose panel: not a pricing schedule
  // (real rows already, an AI guess would be worse) or a drawing (never
  // text-extracted, see analyze-document.ts).
  const scopeDocs = await db.document.findMany({
    where: {
      opportunityId,
      deletedAt: null,
      documentType: { notIn: ["PRICING_SCHEDULE", "DRAWING"] },
      ...notOtherProject,
    },
    orderBy: { createdAt: "asc" },
  });
  for (const doc of scopeDocs) {
    if (doc.extractionStatus !== "COMPLETE") {
      skipped.push({ filename: doc.filename, reason: "Not analyzed yet -- click Analyze on the Opportunity page first." });
      continue;
    }
    if (await alreadyCommitted(estimateVersionId, doc.id)) {
      skipped.push({ filename: doc.filename, reason: "Already imported into this estimate." });
      continue;
    }
    try {
      // proposedLineItems is cached on the Document once proposed (see
      // scope-line-item-service.ts) -- reuse it instead of a repeat
      // OpenAI call for a document someone already ran Propose on by hand.
      if (!doc.proposedLineItems) {
        await proposeLineItemsFromScope(doc.id, userId);
      }
      const result = await commitScopeLineItems(estimateVersionId, doc.id);
      imported.push({ filename: doc.filename, kind: "scope", rowsImported: result.rowsImported });
    } catch (err) {
      skipped.push({ filename: doc.filename, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { imported, skipped };
}
