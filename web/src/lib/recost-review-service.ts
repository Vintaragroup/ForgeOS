// Assembles the re-cost review for an estimate.
//
// Step 3 of docs/recost-review.md, and deliberately the last one with no
// AI in it. Two sources, both deterministic:
//
//   the estimator's own status column on a revised schedule, which is
//   the primary source and states outright what a vision model would be
//   guessing at (recost-status.ts)
//
//   documents whose validity has lapsed, which contribute money at risk
//   rather than savings (document-validity.ts)
//
// The output is a rollup whose headline is the gap to the client's
// number, never the saving. See recost-rollup.ts for why.

import { db } from "@/lib/db";
import { getDocumentBytes } from "@/lib/document-service";
import { readSummaryFromBytes } from "@/lib/recost-summary-reader";
import { readCostBreakout } from "@/lib/cost-breakout-reader";
import { diffCostBreakouts, type CostBreakoutDiff } from "@/lib/cost-breakout-diff";
import { pairSummaryRows, summariseChanges, type ElementChange } from "@/lib/recost-status";
import { groupStaleLineItems, type ValiditySource } from "@/lib/document-validity";
import { buildRecostRollup, parseTargetAmount, untouchedCandidates, type RecostLine } from "@/lib/recost-rollup";
import { corroborateDrawingAgainstSchedule, corroborationHeadline } from "@/lib/recost-corroboration";
import { describeEffect, effectOf, movesMoney } from "@/lib/recost-apply";
import { readStoredComparison } from "@/lib/drawing-comparison";
import type { RecostReview } from "@/lib/recost-review";

export type { RecostReview };

export async function buildRecostReview(estimateId: string): Promise<RecostReview | null> {
  const estimate = await db.estimate.findFirst({
    where: { id: estimateId, deletedAt: null },
    select: { id: true, opportunityId: true },
  });
  if (!estimate) return null;

  // The version being re-costed is the open one. Findings are computed
  // against what the client received, but they land here.
  const version = await db.estimateVersion.findFirst({
    where: { estimateId, isLocked: false },
    orderBy: { versionNumber: "desc" },
    select: { id: true, versionNumber: true, totalCost: true, grandTotal: true },
  });
  if (!version) return null;

  const revisionEvent = await db.proposalEvent.findFirst({
    where: { toStatus: "REVISIONS_REQUESTED", proposal: { estimateVersion: { estimateId } } },
    orderBy: { createdAt: "desc" },
    select: { note: true, createdAt: true },
  });

  const documents = await db.document.findMany({
    where: { opportunityId: estimate.opportunityId, deletedAt: null },
    select: {
      id: true,
      filename: true,
      documentType: true,
      validity: true,
      validityNote: true,
      supersedesId: true,
      revisionComparison: true,
    },
  });

  const supersededBy = new Map<string, { id: string; filename: string }>();
  for (const d of documents) {
    if (d.supersedesId) supersededBy.set(d.supersedesId, { id: d.id, filename: d.filename });
  }

  const sources: ValiditySource[] = documents.map((d) => ({
    id: d.id,
    filename: d.filename,
    validity: d.validity,
    validityNote: d.validityNote,
    supersededByFilename: supersededBy.get(d.id)?.filename ?? null,
  }));

  const lineItems = (
    await db.lineItem.findMany({
      where: { section: { estimateVersionId: version.id } },
      select: { documentId: true, totalCost: true },
    })
  ).map((i) => ({ documentId: i.documentId, totalCost: i.totalCost.toNumber() }));

  // A validity explanation carrying an estimator's own note ends wherever
  // they stopped typing, and another sentence is about to be appended to
  // it. "Fuse is no longer supplying AV on this job 16 line items still
  // carry its pricing" is what that reads like otherwise.
  const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
  const stillCarry = (n: number) => (n === 1 ? "1 line item still carries" : `${n} line items still carry`);

  const staleGroups = groupStaleLineItems(lineItems, sources);
  const lines: RecostLine[] = [];
  const notes: string[] = [];
  let elementChanges: ElementChange[] = [];
  let breakoutDiff: CostBreakoutDiff | null = null;

  for (const group of staleGroups) {
    if (group.validity === "WITHDRAWN") {
      // No replacement exists, so this is money at risk and never a
      // saving -- whatever replaces it has not been priced.
      lines.push({
        label: group.filename,
        detail: `${sentence(group.detail)} ${stillCarry(group.lineItemCount)} its pricing.`,
        status: "NEEDS_RESOURCING",
        costDelta: null,
        costAtRisk: group.totalCost,
      });
      continue;
    }

    // Superseded: there is a replacement, so the change may be readable.
    const replacement = supersededBy.get(group.documentId);
    const changes = replacement ? await readElementChanges(group.documentId, replacement.id) : null;

    if (!changes) {
      lines.push({
        label: group.filename,
        detail:
          `${sentence(group.detail)} ${stillCarry(group.lineItemCount)} its pricing, ` +
          "and the replacement has no readable element summary.",
        status: "NEEDS_REVIEW",
        costDelta: null,
        costAtRisk: group.totalCost,
      });
      continue;
    }

    elementChanges = [...elementChanges, ...changes];
    // The same two workbooks read at row resolution rather than element
    // resolution. Where the Summary says an element moved $24,647, this
    // says which fifteen rows moved and by how much -- which is what
    // actually has to be changed in the open version.
    breakoutDiff = await readBreakoutDiff(group.documentId, replacement!.id);
    const summary = summariseChanges(changes);
    lines.push({
      label: group.filename,
      detail:
        `Re-costed in ${replacement!.filename}: ` +
        `${summary.eliminatedCount} eliminated, ${summary.repricedCount} repriced, ${summary.unchangedCount} unchanged` +
        (summary.needsReviewCount > 0 ? `, ${summary.needsReviewCount} needing review` : ""),
      status: "RECOSTED",
      costDelta: summary.delta,
      costAtRisk: null,
    });
  }

  if (lines.length === 0) {
    notes.push("No document on this opportunity has been superseded or withdrawn, so there is nothing to re-cost yet.");
  }

  // The second witness. A revised drawing compared against the one it
  // replaces sees what no spreadsheet does -- scope added, scope moved,
  // a sign that changed shape -- and it saw it without knowing what the
  // estimator wrote down. Newest comparison wins when there are several.
  const comparisons = documents
    .map((d) => readStoredComparison(d.revisionComparison))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.comparedAt.localeCompare(a.comparedAt));
  const comparison = comparisons[0] ?? null;

  const drawing = comparison
    ? (() => {
        const findings = corroborateDrawingAgainstSchedule({
          findings: comparison.findings,
          elements: elementChanges,
          charactersMismatched: comparison.charactersMismatched,
        });
        return {
          revisedFilename: comparison.revisedFilename,
          previousFilename: comparison.previousFilename,
          headline: corroborationHeadline(findings, comparison.revisedFilename),
          charactersMismatched: comparison.charactersMismatched,
          findings,
        };
      })()
    : null;

  // What the AI stage proposed last time it ran, still undecided. Read
  // here rather than re-run: a proposal costs a model call and the
  // findings behind it do not change until another document arrives.
  //
  // Targets are resolved with their own queries because RecostProposal
  // deliberately holds lineItemId as a plain column rather than a
  // relation -- a proposal outlives the row it is about, and a proposal
  // that vanished when somebody deleted a line item would take the
  // reason it was raised with it.
  const allProposals = await db.recostProposal.findMany({
    where: { estimateVersionId: version.id },
    orderBy: { createdAt: "desc" },
  });
  const stored = allProposals.filter((p) => p.status === "PROPOSED");

  const proposalLineItems = new Map(
    (
      await db.lineItem.findMany({
        where: { id: { in: allProposals.map((p) => p.lineItemId).filter((id): id is string => id !== null) } },
        select: { id: true, description: true, totalCost: true, qty: true, unitCost: true },
      })
    ).map((li) => [li.id, li]),
  );
  const proposalSections = new Map(
    (
      await db.estimateSection.findMany({
        where: { id: { in: allProposals.map((p) => p.sectionId).filter((id): id is string => id !== null) } },
        select: { id: true, name: true, groupLabel: true },
      })
    ).map((sec) => [sec.id, sec]),
  );
  const proposalDocuments = new Map(
    (
      await db.document.findMany({
        where: { id: { in: [...new Set(stored.map((p) => p.sourceDocumentId))] } },
        select: { id: true, filename: true },
      })
    ).map((d) => [d.id, d]),
  );

  // A section removal's real size, so the screen can say "all 25 line
  // items, $7,917" instead of "this section".
  const sectionTotals = new Map<string, { count: number; amount: number }>();
  for (const sectionId of new Set(stored.map((p) => p.sectionId).filter((id): id is string => id !== null))) {
    const items = await db.lineItem.findMany({ where: { sectionId }, select: { totalCost: true } });
    sectionTotals.set(sectionId, {
      count: items.length,
      amount: items.reduce((n, li) => n + li.totalCost.toNumber(), 0),
    });
  }

  const proposals = stored.map((p) => {
    const lineItem = p.lineItemId ? proposalLineItems.get(p.lineItemId) : undefined;
    const section = p.sectionId ? proposalSections.get(p.sectionId) : undefined;
    const effect = effectOf({
      action: p.action,
      lineItemId: p.lineItemId,
      sectionId: p.sectionId,
      newUnitCost: p.newUnitCost?.toNumber() ?? null,
      newQty: p.newQty?.toNumber() ?? null,
    });
    const sectionSize = p.sectionId ? sectionTotals.get(p.sectionId) : undefined;
    return {
      id: p.id,
      action: p.action,
      confidence: p.confidence,
      reason: p.reason,
      target:
        lineItem?.description ??
        (section ? [section.groupLabel, section.name].filter(Boolean).join(" / ") : "(no longer in this estimate)"),
      amount: lineItem?.totalCost.toNumber() ?? p.newUnitCost?.toNumber() ?? null,
      sourceQuote: p.sourceQuote,
      sourceFilename: proposalDocuments.get(p.sourceDocumentId)?.filename ?? "(source removed)",
      effect: describeEffect(effect, {
        itemCount: sectionSize?.count,
        amount: sectionSize?.amount ?? lineItem?.totalCost.toNumber(),
      }),
      movesMoney: movesMoney(effect),
    };
  });

  // A decided proposal's line item is usually gone -- that is what
  // applying a removal means -- so the name is kept from the proposal's
  // own record rather than looked up and found missing.
  const decidedBy = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...new Set(allProposals.map((p) => p.decidedById).filter((id): id is string => id !== null))] } },
        select: { id: true, name: true },
      })
    ).map((u) => [u.id, u.name]),
  );

  const decided = allProposals
    .filter((p) => p.status !== "PROPOSED")
    .map((p) => {
      const section = p.sectionId ? proposalSections.get(p.sectionId) : undefined;
      return {
        id: p.id,
        status: p.status,
        action: p.action,
        target:
          (p.lineItemId ? proposalLineItems.get(p.lineItemId)?.description : undefined) ??
          (section ? [section.groupLabel, section.name].filter(Boolean).join(" / ") : undefined) ??
          "(removed from the estimate)",
        reason: p.reason,
        sourceQuote: p.sourceQuote,
        decidedBy: (p.decidedById ? decidedBy.get(p.decidedById) : null) ?? "someone",
        decidedAt: p.decidedAt,
      };
    });

  // Two independent reads of one pair of workbooks. They agree on Full
  // Swing to within half a dollar, which is the point of computing both
  // -- a disagreement means one of them is reading something wrong, and
  // that is worth a person's attention rather than a silent pick.
  const summaryDelta = elementChanges.length > 0 ? summariseChanges(elementChanges).delta : null;
  const lineItemDiff = breakoutDiff
    ? {
        costDelta: breakoutDiff.costDelta,
        changedRows: breakoutDiff.changedRows,
        removedRows: breakoutDiff.removedRows,
        addedRows: breakoutDiff.addedRows,
        disagreesWithSummaryBy:
          summaryDelta !== null && Math.abs(summaryDelta - breakoutDiff.costDelta) >= 1
            ? breakoutDiff.costDelta - summaryDelta
            : null,
        elements: breakoutDiff.elements
          .filter((e) => e.changes.length > 0 || e.titleChanged)
          .map((e) => ({
            tab: e.tab,
            titleChanged: e.titleChanged,
            previousTitle: e.previousTitle,
            currentTitle: e.currentTitle,
            elementRemoved: e.elementRemoved,
            previousTotal: e.previousTotal,
            currentTotal: e.currentTotal,
            changes: e.changes.map((c) => ({
              kind: c.kind,
              description: c.description,
              variant: c.variant,
              previousQty: c.previousQty,
              currentQty: c.currentQty,
              previousUnitCost: c.previousUnitCost,
              currentUnitCost: c.currentUnitCost,
              costDelta: c.costDelta,
            })),
          })),
      }
    : null;

  // The batch's own scope, computed the same way the batch selects:
  // recommended, and never a removal. The money is what those rows would
  // actually move, from the numbers already stored on them.
  const recommendedRows = stored.filter(
    (p) => p.confidence === "RECOMMEND_AND_CONFIRM" && p.action !== "REMOVE" && p.lineItemId !== null,
  );
  const recommended = {
    count: recommendedRows.length,
    costDelta: recommendedRows.reduce((total, p) => {
      const lineItem = p.lineItemId ? proposalLineItems.get(p.lineItemId) : undefined;
      if (!lineItem) return total;
      const before = lineItem.totalCost.toNumber();
      const qty = p.newQty?.toNumber() ?? lineItem.qty.toNumber();
      const unitCost = p.newUnitCost?.toNumber() ?? lineItem.unitCost.toNumber();
      return total + (qty * unitCost - before);
    }, 0),
  };

  const currentCost = version.totalCost.toNumber();
  const currentSell = version.grandTotal.toNumber();
  const target = parseTargetAmount(revisionEvent?.note ?? null);
  if (revisionEvent && target === null) {
    notes.push("No budget figure could be read from the client's request, so no gap is shown. Set one to see it.");
  }

  const rollup = buildRecostRollup({ lines, currentCost, currentSell, target });

  // Only ever a prompt to look, never a proposal: these are untouched
  // because an estimator decided not to touch them.
  const suggestions = untouchedCandidates(
    elementChanges
      .filter((c) => c.action === "NONE")
      .map((c) => ({ label: c.element, cost: c.currentTotal ?? 0, status: "UNCHANGED" as const })),
    rollup.gap,
  ).map(({ label, cost }) => ({ label, cost }));

  if (rollup.costAtRisk > 0) {
    notes.push(
      "Money at risk is not counted as a saving. Whatever replaces a withdrawn source has not been priced yet.",
    );
  }

  return {
    estimateVersionId: version.id,
    versionNumber: version.versionNumber,
    requestNote: revisionEvent?.note ?? null,
    requestedAt: revisionEvent?.createdAt ?? null,
    rollup,
    elementChanges,
    suggestions,
    drawing,
    lineItemDiff,
    proposals,
    recommended,
    decided,
    notes,
  };
}

// The row-level read of the same pair. Kept separate from the summary
// read because either can be absent: a workbook may carry a Summary tab
// and no element tabs, or the reverse.
async function readBreakoutDiff(previousId: string, revisedId: string): Promise<CostBreakoutDiff | null> {
  try {
    const [previous, revised] = await Promise.all([
      getDocumentBytes(previousId).then(async (r) => {
        const wb = new (await import("exceljs")).default.Workbook();
        await wb.xlsx.load(r.bytes as unknown as ArrayBuffer);
        return readCostBreakout(wb);
      }),
      getDocumentBytes(revisedId).then(async (r) => {
        const wb = new (await import("exceljs")).default.Workbook();
        await wb.xlsx.load(r.bytes as unknown as ArrayBuffer);
        return readCostBreakout(wb);
      }),
    ]);
    if (previous.length === 0 || revised.length === 0) return null;
    return diffCostBreakouts(previous, revised);
  } catch (err) {
    console.warn(`[recost] could not read cost breakout rows for ${previousId} -> ${revisedId}`, err);
    return null;
  }
}

// Reads both workbooks' element summaries and pairs them. Returns null
// rather than a partial answer when either side cannot be read -- a
// half-parsed summary produces confident nonsense about money.
async function readElementChanges(previousId: string, revisedId: string): Promise<ElementChange[] | null> {
  try {
    const [previous, revised] = await Promise.all([
      getDocumentBytes(previousId).then((r) => readSummaryFromBytes(r.bytes)),
      getDocumentBytes(revisedId).then((r) => readSummaryFromBytes(r.bytes)),
    ]);
    if (!previous || !revised) return null;
    return pairSummaryRows(previous.rows, revised.rows);
  } catch (err) {
    // A document whose bytes cannot be fetched, or a file that is not a
    // workbook at all. Both are ordinary here -- a superseded PDF has no
    // element summary either -- so this is a null, not an error.
    console.warn(`[recost] could not read element summaries for ${previousId} -> ${revisedId}`, err);
    return null;
  }
}
