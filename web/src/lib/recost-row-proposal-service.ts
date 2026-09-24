// Turns the row-by-row workbook comparison into proposals an estimator
// can accept.
//
// The other proposal stage (ai/recost-proposal-service.ts) asks a model
// which line items a drawing observation is about, and every answer
// comes back through a gate. This one asks nothing. The rows join to
// line items exactly -- the import stored each row's own cell text, so
// (tab + composed description) names the line item that row created --
// and the numbers are the ones the estimating lead typed.
//
// So these carry RECOMMEND_AND_CONFIRM rather than NEED_YOUR_DECISION,
// with two exceptions that stay a decision whatever the source says:
//
//   a removal, because taking scope off a job is a judgement even when
//   the workbook is unambiguous, and value engineering removes almost
//   nothing (two of forty elements on this job)
//
//   a row that joins to more than one line item, because picking one is
//   a guess and this stage does not guess
//
// A row that joins to nothing is skipped and counted. That is a gap in
// the estimate's provenance, not something to invent a target for.

import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { getDocumentBytes } from "@/lib/document-service";
import { readCostBreakout } from "@/lib/cost-breakout-reader";
import { diffCostBreakouts, type RowChange } from "@/lib/cost-breakout-diff";
import { effectiveValidity } from "@/lib/document-validity";
import type { Prisma } from "@/generated/prisma/client";

export interface RowProposalRun {
  proposed: number;
  // Rows whose line item could not be identified. Reported rather than
  // swallowed: it is the number that says how much of the workbook this
  // stage can actually speak for.
  unjoined: number;
  ambiguous: number;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// "SS - Lounge Structure" became "FS - Lounge Structure" when the client
// column was relabelled, so a change read off the revised workbook may
// name a tab the estimate's sections do not use. Matched without the
// client prefix, exactly as the diff pairs the tabs themselves.
const withoutClient = (tab: string) => {
  const separator = tab.indexOf(" - ");
  return norm(separator === -1 ? tab : tab.slice(separator + 3));
};

function actionFor(change: RowChange): "REMOVE" | "ADJUST_QTY" | "REPRICE" {
  if (change.kind === "REMOVED") return "REMOVE";
  // A price move is a reprice; anything touching quantity is an
  // adjustment, in whichever direction the workbook took it.
  return change.kind === "PRICE" ? "REPRICE" : "ADJUST_QTY";
}

// The citation. A cell reference rather than a sentence, because that is
// what this evidence is -- and it is checkable in the file itself, which
// a paraphrase would not be.
function citationFor(change: RowChange): string {
  const qty = `qty ${change.previousQty ?? "—"} → ${change.currentQty ?? "—"}`;
  const unit = `unit ${change.previousUnitCost ?? "—"} → ${change.currentUnitCost ?? "—"}`;
  return `${change.description}${change.variant ? ` (${change.variant})` : ""} · ${qty} · ${unit}`;
}

export async function proposeFromCostBreakout(estimateId: string, userId: string): Promise<RowProposalRun> {
  const estimate = await db.estimate.findFirstOrThrow({
    where: { id: estimateId, deletedAt: null },
    select: { opportunityId: true },
  });
  const version = await db.estimateVersion.findFirst({
    where: { estimateId, isLocked: false },
    orderBy: { versionNumber: "desc" },
    select: { id: true },
  });
  if (!version) throw new UserError("This estimate has no open version to re-cost.");

  const documents = await db.document.findMany({
    where: { opportunityId: estimate.opportunityId, deletedAt: null },
    select: { id: true, filename: true, validity: true, supersedesId: true },
  });
  const successorOf = new Map<string, { id: string; filename: string }>();
  for (const d of documents) {
    if (d.supersedesId) successorOf.set(d.supersedesId, { id: d.id, filename: d.filename });
  }

  // The superseded workbook and the one that replaced it. Only a pair
  // that both parse as cost breakouts is usable here.
  const pair = documents
    .map((d) => ({ previous: d, revised: successorOf.get(d.id) ?? null }))
    .find(
      (p) =>
        p.revised !== null &&
        effectiveValidity({
          validity: p.previous.validity,
          supersededByFilename: p.revised?.filename ?? null,
        }) === "SUPERSEDED",
    );
  if (!pair?.revised) throw new UserError("No revised cost breakout has been linked to the one it replaces.");

  const [previousSheets, revisedSheets] = await Promise.all([
    readWorkbook(pair.previous.id),
    readWorkbook(pair.revised.id),
  ]);
  if (previousSheets.length === 0 || revisedSheets.length === 0) {
    throw new UserError("Those documents do not read as in-house cost breakouts.");
  }
  const diff = diffCostBreakouts(previousSheets, revisedSheets);

  // Line items indexed the way a workbook row names them: the section's
  // own booth label, and the description the import composed.
  const lineItems = await db.lineItem.findMany({
    where: { section: { estimateVersionId: version.id } },
    select: { id: true, description: true, unitCost: true, section: { select: { groupLabel: true } } },
  });
  const index = new Map<string, { id: string; unitCost: number }[]>();
  for (const item of lineItems) {
    const key = `${withoutClient(item.section.groupLabel ?? "")}::${norm(item.description)}`;
    const list = index.get(key);
    const entry = { id: item.id, unitCost: item.unitCost.toNumber() };
    if (list) list.push(entry);
    else index.set(key, [entry]);
  }

  const rows: Prisma.RecostProposalCreateManyInput[] = [];
  let unjoined = 0;
  let ambiguous = 0;

  for (const element of diff.elements) {
    for (const change of element.changes) {
      // An addition has no line item to point at -- it is scope the
      // estimate does not carry yet, and adding it is a priced decision
      // rather than an edit.
      if (change.kind === "ADDED") continue;

      const candidates = index.get(`${withoutClient(change.tab)}::${norm(change.description)}`) ?? [];
      if (candidates.length === 0) {
        unjoined += 1;
        continue;
      }
      // Two rows can share a description -- "China Birch" at two
      // thicknesses. The previous unit cost separates them; where it
      // does not, this stage declines rather than picks.
      const matched =
        candidates.length === 1
          ? candidates
          : candidates.filter((c) => change.previousUnitCost !== null && Math.abs(c.unitCost - change.previousUnitCost) < 0.005);
      if (matched.length !== 1) {
        ambiguous += 1;
        continue;
      }

      const action = actionFor(change);
      rows.push({
        estimateVersionId: version.id,
        lineItemId: matched[0].id,
        action,
        reason:
          action === "REMOVE"
            ? `${pair.revised.filename} no longer carries this row.`
            : `${pair.revised.filename} re-costs this row.`,
        sourceDocumentId: pair.revised.id,
        sourceQuote: citationFor(change),
        sourceLocation: change.tab,
        // A removal stays a decision however unambiguous the workbook
        // is; everything else is the estimating lead's own arithmetic.
        confidence: action === "REMOVE" ? "NEED_YOUR_DECISION" : "RECOMMEND_AND_CONFIRM",
        newQty: action === "REMOVE" ? null : change.currentQty,
        newUnitCost: action === "REMOVE" ? null : change.currentUnitCost,
      });
    }
  }

  // Replaced rather than appended, same as the AI stage: a re-run is a
  // re-read of the same two files. Decided rows survive.
  await db.$transaction(async (tx) => {
    await tx.recostProposal.deleteMany({
      where: { estimateVersionId: version.id, status: "PROPOSED", sourceDocumentId: pair.revised!.id },
    });
    if (rows.length > 0) await tx.recostProposal.createMany({ data: rows });
  });

  console.info(
    `[recost] ${rows.length} row proposals from ${pair.revised.filename} (${unjoined} unjoined, ${ambiguous} ambiguous), by ${userId}`,
  );
  return { proposed: rows.length, unjoined, ambiguous };
}

async function readWorkbook(documentId: string) {
  const { bytes } = await getDocumentBytes(documentId);
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return readCostBreakout(workbook);
}
