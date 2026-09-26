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

import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { Document } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { commitPricingImport, previewPricingImport } from "@/lib/pricing-import-service";
import { commitScopeLineItems, proposeLineItemsFromScope } from "@/lib/ai/scope-line-item-service";
import { proposeLineItemsFromDrawing } from "@/lib/ai/drawing-line-item-service";
import { filenameStem } from "@/lib/document-filename";
import { findClientPricingTemplateSheet } from "@/lib/client-pricing-template-service";
import { XLSX_MIME } from "@/lib/ai/text-extraction";

export interface BuildEstimateResult {
  imported: { filename: string; kind: "pricing" | "scope" | "drawing"; rowsImported: number }[];
  skipped: { filename: string; reason: string }[];
  // Set when the run ended with work still to do. Null means it finished
  // everything there was.
  stopped: { reason: string; remaining: number } | null;
}

// How long this run gives itself, well inside the route's own
// maxDuration of 600s (see the estimates page).
//
// The point is to stop BEFORE the platform does. On The Pharmacy Hub --
// six documents, two twelve-page drawings -- the build ran past ten
// minutes and Vercel killed the function mid-drawing. The estimator got
// "Something went wrong" and no way to tell what had run, because a
// killed process cannot write down why it stopped.
//
// 480s leaves two minutes of headroom, which is roughly what one drawing
// batch costs (42-83s each, measured on that job).
const BUILD_BUDGET_MS = 480_000;

// Checked BETWEEN documents, not inside one. A single document that alone
// outruns the remaining budget can still be killed -- the redline drawing
// on that job took 386s by itself, which fits but not by much. If that
// starts biting, the next move is checking between batches inside
// drawing-line-item-service, which is more invasive than this.
class BuildBudget {
  private readonly deadline: number;
  constructor(budgetMs: number = BUILD_BUDGET_MS) {
    this.deadline = Date.now() + budgetMs;
  }
  get exhausted(): boolean {
    return Date.now() >= this.deadline;
  }
  get minutesSpent(): string {
    return ((BUILD_BUDGET_MS - (this.deadline - Date.now())) / 60_000).toFixed(1);
  }
}

async function alreadyCommitted(estimateVersionId: string, documentId: string): Promise<boolean> {
  const existing = await db.lineItem.findFirst({
    where: { documentId, section: { estimateVersionId, optionId: null } },
  });
  return !!existing;
}

// Shared by the text-scope and drawing loops below -- same propose/commit
// shape, differing only in which propose function actually reads the
// document (extracted text vs. vision page images) and the "kind" label
// attached to a successful import.
//
// No longer skips a document that already has SOME committed line items
// (the old alreadyCommitted pre-check did, unconditionally) -- that used
// to hard-block ever re-processing a partially-committed document through
// this one-click path, which is exactly the recovery scenario duplicate
// detection exists for (see line-item-duplicate-service.ts's own header
// comment). commitScopeLineItems is called with no selectedIndices here
// (this is a non-UI caller), so it already applies its own safe default
// -- silently excluding whatever fresh Tier 1 and cached Tier 2 flag as
// an existing duplicate -- rather than either blindly re-inserting
// everything or refusing to run at all.
async function proposeAndCommit(
  estimateVersionId: string,
  opportunityId: string,
  userId: string | null,
  docs: Document[],
  kind: "scope" | "drawing",
  proposeFn: (documentId: string, opportunityId: string, userId: string | null, versionId: string | null) => Promise<unknown>,
  imported: BuildEstimateResult["imported"],
  skipped: BuildEstimateResult["skipped"],
  progress: BuildProgress,
): Promise<"done" | "out-of-time"> {
  for (const doc of docs) {
    if (progress.budget.exhausted) return "out-of-time";
    if (doc.extractionStatus !== "COMPLETE") {
      skipped.push({ filename: doc.filename, reason: "Not analyzed yet -- click Analyze on the Opportunity page first." });
      continue;
    }
    await progress.startingOn(doc.filename);
    try {
      // proposedLineItems is cached on the Document once proposed (see
      // scope-line-item-service.ts / drawing-line-item-service.ts) --
      // reuse it instead of a repeat OpenAI call for a document someone
      // already ran Propose on by hand. docs here are already scoped to
      // opportunityId (the findMany calls below), so this opportunityId
      // is genuinely the document's own -- not a redundant re-trust of
      // unchecked input.
      if (!doc.proposedLineItems) {
        await proposeFn(doc.id, opportunityId, userId, estimateVersionId);
      }
      const result = await commitScopeLineItems(estimateVersionId, doc.id);
      imported.push({ filename: doc.filename, kind, rowsImported: result.rowsImported });
    } catch (err) {
      skipped.push({ filename: doc.filename, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return "done";
}

// Writes what the build is doing as it goes, so an interrupted run can
// say where it got to rather than leaving an error boundary to explain
// itself.
class BuildProgress {
  readonly budget: BuildBudget;
  private index = 0;
  constructor(
    private readonly estimateVersionId: string,
    private readonly total: number,
    budgetMs: number = BUILD_BUDGET_MS,
  ) {
    this.budget = new BuildBudget(budgetMs);
  }

  async startingOn(filename: string) {
    this.index += 1;
    await db.estimateVersion.update({
      where: { id: this.estimateVersionId },
      data: { buildStepIndex: this.index, buildStepTotal: this.total, buildCurrentFile: filename },
    });
  }
}

export async function buildEstimateFromAllDocuments(
  estimateVersionId: string,
  opportunityId: string,
  userId: string | null,
  // Overridden only by tests, which need a budget that is already spent
  // to exercise the stop path without waiting eight minutes for it.
  budgetMs: number = BUILD_BUDGET_MS,
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

  // Every document this run could touch, counted before any work starts,
  // so progress can say "3 of 6" rather than "3 so far".
  const totalDocs = await db.document.count({ where: { opportunityId, deletedAt: null, ...notOtherProject } });
  const progress = new BuildProgress(estimateVersionId, totalDocs, budgetMs);
  await db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: {
      buildStartedAt: new Date(),
      buildFinishedAt: null,
      buildStoppedReason: null,
      buildStepIndex: 0,
      buildStepTotal: totalDocs,
      buildCurrentFile: null,
    },
  });

  // Ends the run, recording why. finish(null) means it got through
  // everything; a reason means there is more to do and the estimator is
  // told what and why rather than being handed an error boundary.
  const finish = async (stopped: BuildEstimateResult["stopped"]): Promise<BuildEstimateResult> => {
    const report: BuildEstimateResult = { imported, skipped, stopped };
    await db.estimateVersion.update({
      where: { id: estimateVersionId },
      data: {
        buildFinishedAt: new Date(),
        buildStoppedReason: stopped?.reason ?? null,
        buildCurrentFile: null,
        buildReport: report as unknown as Prisma.InputJsonValue,
      },
    });
    return report;
  };

  const outOfTime = (remaining: number): BuildEstimateResult["stopped"] => ({
    reason:
      `Stopped after ${progress.budget.minutesSpent} minutes to stay inside the ten-minute limit, ` +
      `with ${remaining} document${remaining === 1 ? "" : "s"} still to process. ` +
      "Nothing was lost -- click again to carry on from here.",
    remaining,
  });

  // The client's own bid-comparison template (e.g. "Exhibit 1...") is
  // legitimately IMPORTABLE via the flat-schedule parser -- confirmed
  // live, it deterministically resolves to kind "pricing-schedule" with
  // real rows, some catalog-matched -- and is meant to be the estimator's
  // real pricing source on a job with no vendor-engineered workbook yet
  // (pricing-import-service.test.ts's own fixture comment: "the correct,
  // intended way to import this file's rows"). The actual problem is
  // narrower: on a job that ALSO has a real per-booth vendor workbook
  // (design-cost-estimate import), the client's own coarse "Complete
  // Booth Build" narrative rows just double-count the same scope the
  // vendor workbook already covers granularly and priced -- confirmed
  // live, a real production estimate ended up with 17 such $0-mostly
  // rows once both were imported. So: skip a client-template-shaped
  // document only once real granular vendor data already exists (or will,
  // from this same batch) -- never skip it when it's the only pricing
  // source this job has.
  const hasCommittedVendorData = await db.lineItem.findFirst({
    where: { section: { estimateVersionId, optionId: null }, positionCode: { not: null } },
  });
  let hasGranularVendorSource = !!hasCommittedVendorData;
  if (!hasGranularVendorSource) {
    for (const doc of pricingDocs) {
      const preview = await previewPricingImport(doc.id, opportunityId).catch(() => null);
      if (preview?.kind === "design-cost-estimate") {
        hasGranularVendorSource = true;
        break;
      }
    }
  }

  for (const doc of pricingDocs) {
    if (progress.budget.exhausted) {
      const remaining = pricingDocs.length - imported.length - skipped.length;
      return finish(outOfTime(remaining));
    }
    await progress.startingOn(doc.filename);
    // No longer hard-skipped outright just because it already contributed
    // SOME line items -- same reason proposeAndCommit's own identical
    // skip was removed above: commitPricingImport (and everything it
    // dispatches to) now safely excludes an exact duplicate on its own
    // rather than either refusing to run or blindly re-inserting
    // everything, so re-running this one-click action can pick up
    // whatever's genuinely missing from an already-partially-committed
    // pricing document instead of ignoring it entirely.
    if (hasGranularVendorSource && doc.mimeType === XLSX_MIME) {
      const { bytes } = await getDocumentBytes(doc.id);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
      if (findClientPricingTemplateSheet(workbook)) {
        skipped.push({
          filename: doc.filename,
          reason:
            "This is the client's own bid-comparison template, and a real vendor workbook already covers this job's scope in more detail -- use Reconcile Against Client Template instead of importing it as line items.",
        });
        continue;
      }
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
  const scopeOutcome = await proposeAndCommit(
    estimateVersionId, opportunityId, userId, scopeDocs, "scope", proposeLineItemsFromScope, imported, skipped, progress,
  );
  if (scopeOutcome === "out-of-time") {
    const drawingsLeft = await db.document.count({ where: { opportunityId, deletedAt: null, documentType: "DRAWING", ...notOtherProject } });
    return finish(outOfTime(scopeDocs.length - imported.length - skipped.length + drawingsLeft));
  }

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
  const drawingOutcome = await proposeAndCommit(
    estimateVersionId, opportunityId, userId, drawingDocs, "drawing", proposeLineItemsFromDrawing, imported, skipped, progress,
  );
  if (drawingOutcome === "out-of-time") {
    const done = new Set(imported.map((i) => i.filename).concat(skipped.map((s2) => s2.filename)));
    return finish(outOfTime(drawingDocs.filter((d) => !done.has(d.filename)).length));
  }

  return finish(null);
}
