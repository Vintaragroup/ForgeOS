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
import type { Document } from "@/generated/prisma/client";
import { commitPricingImport } from "@/lib/pricing-import-service";
import { commitScopeLineItems, proposeLineItemsFromScope } from "@/lib/ai/scope-line-item-service";
import { proposeLineItemsFromDrawing } from "@/lib/ai/drawing-line-item-service";

export interface BuildEstimateResult {
  imported: { filename: string; kind: "pricing" | "scope" | "drawing"; rowsImported: number }[];
  skipped: { filename: string; reason: string }[];
}

async function alreadyCommitted(estimateVersionId: string, documentId: string): Promise<boolean> {
  const existing = await db.lineItem.findFirst({
    where: { documentId, section: { estimateVersionId, optionId: null } },
  });
  return !!existing;
}

// A CAD drawing and its vendor's own per-booth pricing workbook share the
// same filename stem in every real job seen so far (e.g. "SUPER BOWL A
// 6.8.2 SECTION 428.pdf" / "SUPER BOWL A 6.8.2 SECTION 428.xlsx") --
// confirmed live against a real production job where this exact pairing
// existed for all 13 booths. Used below to recognize "this drawing's
// scope was already captured, in more detail and with real pricing, by
// its matching workbook" -- without it, the vision-based drawing pipeline
// has no way to know that, and produces a crude, zero-cost "Complete
// Booth Build" summary line duplicating scope the real import already
// priced correctly.
function filenameStem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").trim().toLowerCase();
}

// Shared by the text-scope and drawing loops below -- same skip/propose/
// commit shape, differing only in which propose function actually reads
// the document (extracted text vs. vision page images) and the "kind"
// label attached to a successful import.
async function proposeAndCommit(
  estimateVersionId: string,
  opportunityId: string,
  userId: string | null,
  docs: Document[],
  kind: "scope" | "drawing",
  proposeFn: (documentId: string, opportunityId: string, userId: string | null) => Promise<unknown>,
  imported: BuildEstimateResult["imported"],
  skipped: BuildEstimateResult["skipped"],
) {
  for (const doc of docs) {
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
      // scope-line-item-service.ts / drawing-line-item-service.ts) --
      // reuse it instead of a repeat OpenAI call for a document someone
      // already ran Propose on by hand. docs here are already scoped to
      // opportunityId (the findMany calls below), so this opportunityId
      // is genuinely the document's own -- not a redundant re-trust of
      // unchecked input.
      if (!doc.proposedLineItems) {
        await proposeFn(doc.id, opportunityId, userId);
      }
      const result = await commitScopeLineItems(estimateVersionId, doc.id);
      imported.push({ filename: doc.filename, kind, rowsImported: result.rowsImported });
    } catch (err) {
      skipped.push({ filename: doc.filename, reason: err instanceof Error ? err.message : String(err) });
    }
  }
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
  // (real rows already, an AI guess would be worse) or a drawing (a
  // separate vision-based path below, since it has no extracted text).
  const scopeDocs = await db.document.findMany({
    where: {
      opportunityId,
      deletedAt: null,
      documentType: { notIn: ["PRICING_SCHEDULE", "DRAWING"] },
      ...notOtherProject,
    },
    orderBy: { createdAt: "asc" },
  });
  await proposeAndCommit(estimateVersionId, opportunityId, userId, scopeDocs, "scope", proposeLineItemsFromScope, imported, skipped);

  // Real per-booth pricing schedules (Pricing Schedule or Vendor Quote --
  // the same two types the manual "Import from document" picker accepts)
  // already committed for THIS version -- their filename stems mark a
  // drawing as "already covered," see filenameStem's own comment.
  const committedPricingDocs = await db.document.findMany({
    where: { opportunityId, deletedAt: null, documentType: { in: ["PRICING_SCHEDULE", "VENDOR_QUOTE"] }, ...notOtherProject },
    select: { id: true, filename: true },
  });
  const committedPricingStems = new Set<string>();
  for (const doc of committedPricingDocs) {
    if (await alreadyCommitted(estimateVersionId, doc.id)) committedPricingStems.add(filenameStem(doc.filename));
  }

  const allDrawingDocs = await db.document.findMany({
    where: { opportunityId, deletedAt: null, documentType: "DRAWING", ...notOtherProject },
    orderBy: { createdAt: "asc" },
  });
  const drawingDocs = allDrawingDocs.filter((doc) => {
    if (!committedPricingStems.has(filenameStem(doc.filename))) return true;
    skipped.push({
      filename: doc.filename,
      reason: "A pricing schedule/vendor quote with the same name is already imported -- that already covers this drawing's scope with real pricing.",
    });
    return false;
  });
  await proposeAndCommit(estimateVersionId, opportunityId, userId, drawingDocs, "drawing", proposeLineItemsFromDrawing, imported, skipped);

  return { imported, skipped };
}
