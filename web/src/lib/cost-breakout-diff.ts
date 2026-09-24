// What changed between two in-house cost breakouts, row by row.
//
// The comparison the estimating lead actually asked for: an updated
// workbook arrives, and the system says which rows of the open version
// need updating. Deterministic end to end -- the rows join on the
// description the import itself composed, so nothing here resembles,
// infers or guesses.
//
// Two things make this harder than a row-by-row walk, and both are real
// on Full Swing:
//
//   A tab can be renamed. "SS - Lounge Structure" became "FS - Lounge
//   Structure" because the client column was relabelled, and the rows
//   underneath are untouched. Matching on the tab name alone would
//   report an entire element deleted and another added.
//
//   A description can repeat. "China Birch" is two rows at two
//   thicknesses and two prices; "shipping" appears twice on one tab. So
//   rows are paired in order within their description group rather than
//   by name alone, which keeps the first of each with the first.
//
// A leaf module: pure functions over parsed sheets, no db import.

import type { CostBreakoutRow, CostBreakoutSheet } from "@/lib/cost-breakout-reader";

export type RowChangeKind = "QTY" | "PRICE" | "BOTH" | "REMOVED" | "ADDED";

export interface RowChange {
  kind: RowChangeKind;
  tab: string;
  description: string;
  variant: string | null;
  previousQty: number | null;
  currentQty: number | null;
  previousUnitCost: number | null;
  currentUnitCost: number | null;
  // Negative means cheaper. Null when one side is missing a number.
  costDelta: number | null;
}

export interface ElementChangeSet {
  tab: string;
  // Set when the element's own title changed. Carries spec decisions
  // nothing else records -- "NON LIT", or a hitting bay wall becoming a
  // "ceiling and cantilever piece for monitors".
  previousTitle: string;
  currentTitle: string;
  titleChanged: boolean;
  // True when the whole tab is gone from the revised workbook. The rows
  // are still listed, as removals, because an element leaving is 30
  // decisions rather than one.
  elementRemoved: boolean;
  changes: RowChange[];
  previousTotal: number;
  currentTotal: number;
}

export interface CostBreakoutDiff {
  elements: ElementChangeSet[];
  costDelta: number;
  changedRows: number;
  removedRows: number;
  addedRows: number;
}

const lineTotal = (row: CostBreakoutRow): number => (row.qty ?? 0) * (row.unitCost ?? 0);

// "FS - Lounge Structure" and "SS - Lounge Structure" are the same
// element under two client names. The prefix is dropped only for
// MATCHING; every label shown keeps it, because "Lounge Wall Structure"
// alone does not say whose.
function tabKey(tab: string): string {
  const separator = tab.indexOf(" - ");
  return (separator === -1 ? tab : tab.slice(separator + 3)).toLowerCase().replace(/\s+/g, " ").trim();
}

const rowKey = (row: CostBreakoutRow): string =>
  `${row.block}::${row.description.toLowerCase().replace(/\s+/g, " ").trim()}::${(row.variant ?? "").toLowerCase()}`;

function group(rows: CostBreakoutRow[]): Map<string, CostBreakoutRow[]> {
  const out = new Map<string, CostBreakoutRow[]>();
  for (const row of rows) {
    const key = rowKey(row);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

function changeKind(previous: CostBreakoutRow, current: CostBreakoutRow): RowChangeKind | null {
  const qty = previous.qty !== current.qty;
  const price = previous.unitCost !== current.unitCost;
  if (qty && price) return "BOTH";
  if (qty) return "QTY";
  if (price) return "PRICE";
  return null;
}

function compareRows(previousRows: CostBreakoutRow[], currentRows: CostBreakoutRow[]): RowChange[] {
  const previous = group(previousRows);
  const current = group(currentRows);
  const changes: RowChange[] = [];

  for (const [key, before] of previous) {
    const after = current.get(key) ?? [];
    // Paired in order within the group, so two "shipping" rows keep
    // their own identities rather than collapsing into one.
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const b = before[i];
      const a = after[i];
      if (b && !a) {
        changes.push({
          kind: "REMOVED",
          tab: b.tab,
          description: b.description,
          variant: b.variant,
          previousQty: b.qty,
          currentQty: null,
          previousUnitCost: b.unitCost,
          currentUnitCost: null,
          costDelta: -lineTotal(b),
        });
        continue;
      }
      if (!b && a) {
        changes.push({
          kind: "ADDED",
          tab: a.tab,
          description: a.description,
          variant: a.variant,
          previousQty: null,
          currentQty: a.qty,
          previousUnitCost: null,
          currentUnitCost: a.unitCost,
          costDelta: lineTotal(a),
        });
        continue;
      }
      if (!b || !a) continue;
      const kind = changeKind(b, a);
      if (!kind) continue;
      changes.push({
        kind,
        tab: b.tab,
        description: b.description,
        variant: b.variant,
        previousQty: b.qty,
        currentQty: a.qty,
        previousUnitCost: b.unitCost,
        currentUnitCost: a.unitCost,
        costDelta: lineTotal(a) - lineTotal(b),
      });
    }
  }

  for (const [key, after] of current) {
    if (previous.has(key)) continue;
    for (const a of after) {
      changes.push({
        kind: "ADDED",
        tab: a.tab,
        description: a.description,
        variant: a.variant,
        previousQty: null,
        currentQty: a.qty,
        previousUnitCost: null,
        currentUnitCost: a.unitCost,
        costDelta: lineTotal(a),
      });
    }
  }

  // Biggest saving first: the order the decisions get made in on a job
  // being cut to a budget.
  return changes.sort((x, y) => (x.costDelta ?? 0) - (y.costDelta ?? 0));
}

export function diffCostBreakouts(
  previous: CostBreakoutSheet[],
  current: CostBreakoutSheet[],
): CostBreakoutDiff {
  const currentByKey = new Map(current.map((s) => [tabKey(s.tab), s]));
  const elements: ElementChangeSet[] = [];

  for (const before of previous) {
    const after = currentByKey.get(tabKey(before.tab)) ?? null;
    const changes = compareRows(before.rows, after?.rows ?? []);
    elements.push({
      tab: before.tab,
      previousTitle: before.title,
      currentTitle: after?.title ?? before.title,
      // Compared on the text the estimator typed. They stamp a date on a
      // revised title ("... 091826"), which is a change worth reporting
      // rather than filtering: it is how they mark what they touched.
      titleChanged: !!after && after.title !== before.title,
      elementRemoved: !after,
      changes,
      previousTotal: before.rows.reduce((n, r) => n + lineTotal(r), 0),
      currentTotal: (after?.rows ?? []).reduce((n, r) => n + lineTotal(r), 0),
    });
  }

  // An element only in the revised workbook is new scope, and its rows
  // are all additions.
  const previousKeys = new Set(previous.map((s) => tabKey(s.tab)));
  for (const after of current) {
    if (previousKeys.has(tabKey(after.tab))) continue;
    elements.push({
      tab: after.tab,
      previousTitle: "",
      currentTitle: after.title,
      titleChanged: false,
      elementRemoved: false,
      changes: compareRows([], after.rows),
      previousTotal: 0,
      currentTotal: after.rows.reduce((n, r) => n + lineTotal(r), 0),
    });
  }

  const all = elements.flatMap((e) => e.changes);
  return {
    // Biggest mover first, by absolute money: an element that went up
    // matters as much as one that went down on a job being re-costed.
    elements: elements.sort(
      (a, b) => Math.abs(b.currentTotal - b.previousTotal) - Math.abs(a.currentTotal - a.previousTotal),
    ),
    costDelta: all.reduce((n, c) => n + (c.costDelta ?? 0), 0),
    changedRows: all.filter((c) => c.kind === "QTY" || c.kind === "PRICE" || c.kind === "BOTH").length,
    removedRows: all.filter((c) => c.kind === "REMOVED").length,
    addedRows: all.filter((c) => c.kind === "ADDED").length,
  };
}
