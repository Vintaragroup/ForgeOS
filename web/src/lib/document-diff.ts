// What changed between a document and the one it replaces.
//
// The question this exists for: a vendor sends a revised AV quote. What
// did they drop, what did they add, and what did the price move on?
// Until now a revised quote went through de-duplication -- which only
// ever asks "is this row already here?", one row at a time, in one
// direction. A changed price matched as a duplicate and was silently
// swallowed, and a line the vendor had DROPPED was simply never proposed,
// so nothing noticed it was gone.
//
// The comparison is the new document's parsed rows against the line items
// its PREDECESSOR produced -- which is possible because LineItem.
// documentId records where each row came from. (That provenance was being
// destroyed on every new estimate version until lineItemCreateData was
// fixed; this is what it was for.)
//
// Shares its vocabulary with computeChangeOrderDiff -- ADDED, REMOVED,
// CHANGED -- rather than inventing a second word for the same three
// things.
//
// A leaf module: pure functions over plain rows, no db import.

export interface DiffableRow {
  description: string;
  qty: number;
  unitCost: number;
}

export type DocumentDiffKind = "ADDED" | "REMOVED" | "CHANGED";

export interface DocumentDiffRow {
  description: string;
  kind: DocumentDiffKind;
  previous: { qty: number; unitCost: number; totalCost: number } | null;
  current: { qty: number; unitCost: number; totalCost: number } | null;
  // Positive means this revision costs more.
  delta: number;
  // What actually moved on a CHANGED row. A vendor halving the quantity
  // is a different conversation from one halving the price, and a row
  // that says only "changed" makes you open both documents to find out.
  qtyChanged: boolean;
  unitCostChanged: boolean;
}

export interface DocumentDiff {
  rows: DocumentDiffRow[];
  // Net movement across everything, which is the number someone is
  // actually chasing when a client asks for a lower price.
  netDelta: number;
  previousTotal: number;
  currentTotal: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  unchangedCount: number;
}

// Vendors retype descriptions between revisions -- different spacing,
// different capitalisation, a trailing period. Matching on the raw string
// would report an entire quote as removed-and-re-added.
export function normalizeDescription(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
}

function money(qty: number, unitCost: number): number {
  return Math.round(qty * unitCost * 100) / 100;
}

export function computeDocumentDiff(previous: DiffableRow[], current: DiffableRow[]): DocumentDiff {
  // Duplicate descriptions are real on a quote (two "Shop Supplies"
  // lines), so each side is a queue and they are paired in order rather
  // than collapsed into one.
  const pool = new Map<string, DiffableRow[]>();
  for (const row of previous) {
    const key = normalizeDescription(row.description);
    const list = pool.get(key) ?? [];
    list.push(row);
    pool.set(key, list);
  }

  const rows: DocumentDiffRow[] = [];
  let unchangedCount = 0;

  for (const row of current) {
    const key = normalizeDescription(row.description);
    const match = pool.get(key)?.shift();

    if (!match) {
      rows.push({
        description: row.description,
        kind: "ADDED",
        previous: null,
        current: { qty: row.qty, unitCost: row.unitCost, totalCost: money(row.qty, row.unitCost) },
        delta: money(row.qty, row.unitCost),
        qtyChanged: false,
        unitCostChanged: false,
      });
      continue;
    }

    const qtyChanged = match.qty !== row.qty;
    const unitCostChanged = match.unitCost !== row.unitCost;
    if (!qtyChanged && !unitCostChanged) {
      unchangedCount++;
      continue;
    }

    const before = money(match.qty, match.unitCost);
    const after = money(row.qty, row.unitCost);
    rows.push({
      description: row.description,
      kind: "CHANGED",
      previous: { qty: match.qty, unitCost: match.unitCost, totalCost: before },
      current: { qty: row.qty, unitCost: row.unitCost, totalCost: after },
      delta: Math.round((after - before) * 100) / 100,
      qtyChanged,
      unitCostChanged,
    });
  }

  // Whatever is left in the pool was on the old document and is not on
  // the new one. This is the half de-duplication could never see, and the
  // half most likely to matter: a line the vendor quietly dropped.
  for (const leftovers of pool.values()) {
    for (const row of leftovers) {
      const before = money(row.qty, row.unitCost);
      rows.push({
        description: row.description,
        kind: "REMOVED",
        previous: { qty: row.qty, unitCost: row.unitCost, totalCost: before },
        current: null,
        delta: -before,
        qtyChanged: false,
        unitCostChanged: false,
      });
    }
  }

  // Removals first, then price changes, then additions: a dropped line is
  // the thing most likely to be a mistake, and the thing nobody was being
  // shown at all before.
  const order: Record<DocumentDiffKind, number> = { REMOVED: 0, CHANGED: 1, ADDED: 2 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || Math.abs(b.delta) - Math.abs(a.delta));

  const previousTotal = previous.reduce((sum, r) => sum + money(r.qty, r.unitCost), 0);
  const currentTotal = current.reduce((sum, r) => sum + money(r.qty, r.unitCost), 0);

  return {
    rows,
    netDelta: Math.round((currentTotal - previousTotal) * 100) / 100,
    previousTotal: Math.round(previousTotal * 100) / 100,
    currentTotal: Math.round(currentTotal * 100) / 100,
    addedCount: rows.filter((r) => r.kind === "ADDED").length,
    removedCount: rows.filter((r) => r.kind === "REMOVED").length,
    changedCount: rows.filter((r) => r.kind === "CHANGED").length,
    unchangedCount,
  };
}
