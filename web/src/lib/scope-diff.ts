// What a revised pricing schedule changes, when neither side has a price.
//
// A PRICING_SCHEDULE is not what its name suggests. ForgeOS's parser
// reads category/item/description/unit/qty and no price at all -- the
// cost comes from the catalog at import time. So a client's revised
// workbook cannot be compared on money the way a revised vendor quote
// can (see document-diff.ts, which does exactly that for a quote that
// really does carry prices).
//
// What it CAN be compared on is scope: what they dropped, what they
// added, and where the count moved. On a job where the client asked to
// get from $658k to $250k, "they cut the LED wall and halved the hitting
// bays" is the answer people actually need, and it is knowable without
// any price on either side.
//
// The previous side comes from the line items the OLD document produced
// (LineItem.documentId), not from re-parsing the old workbook -- those
// rows are already here, already reconciled, and are what the estimate
// actually contains.
//
// A leaf module: pure functions over plain rows, no db import.

import { normalizeDescription } from "@/lib/document-diff";

export interface ScopeRow {
  description: string;
  qty: number;
  unit?: string | null;
}

export type ScopeDiffKind = "ADDED" | "REMOVED" | "QTY_CHANGED";

export interface ScopeDiffRow {
  description: string;
  kind: ScopeDiffKind;
  previousQty: number | null;
  currentQty: number | null;
  unit: string | null;
}

export interface ScopeDiff {
  rows: ScopeDiffRow[];
  addedCount: number;
  removedCount: number;
  qtyChangedCount: number;
  unchangedCount: number;
}

export function computeScopeDiff(previous: ScopeRow[], current: ScopeRow[]): ScopeDiff {
  // Duplicate descriptions are real on a schedule (two "Shop Supplies"
  // rows), so each side is a queue and they pair in order rather than
  // collapsing into one -- same posture as computeDocumentDiff.
  const pool = new Map<string, ScopeRow[]>();
  for (const row of previous) {
    const key = normalizeDescription(row.description);
    const list = pool.get(key) ?? [];
    list.push(row);
    pool.set(key, list);
  }

  const rows: ScopeDiffRow[] = [];
  let unchangedCount = 0;

  for (const row of current) {
    const match = pool.get(normalizeDescription(row.description))?.shift();
    if (!match) {
      rows.push({
        description: row.description,
        kind: "ADDED",
        previousQty: null,
        currentQty: row.qty,
        unit: row.unit ?? null,
      });
      continue;
    }
    if (match.qty === row.qty) {
      unchangedCount++;
      continue;
    }
    rows.push({
      description: row.description,
      kind: "QTY_CHANGED",
      previousQty: match.qty,
      currentQty: row.qty,
      unit: row.unit ?? match.unit ?? null,
    });
  }

  // Whatever is left was on the old schedule and is not on the new one.
  // This is the half nothing could see before: a line the client quietly
  // cut was simply never re-proposed, so nothing noticed it was gone.
  for (const leftovers of pool.values()) {
    for (const row of leftovers) {
      rows.push({
        description: row.description,
        kind: "REMOVED",
        previousQty: row.qty,
        currentQty: null,
        unit: row.unit ?? null,
      });
    }
  }

  // Removals first: on a job being cut to a budget, what came OUT is the
  // thing being looked for, and it is the half that was invisible.
  const order: Record<ScopeDiffKind, number> = { REMOVED: 0, QTY_CHANGED: 1, ADDED: 2 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || a.description.localeCompare(b.description));

  return {
    rows,
    addedCount: rows.filter((r) => r.kind === "ADDED").length,
    removedCount: rows.filter((r) => r.kind === "REMOVED").length,
    qtyChangedCount: rows.filter((r) => r.kind === "QTY_CHANGED").length,
    unchangedCount,
  };
}
