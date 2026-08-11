// Best-effort starting price for a pricing-schedule row -- matches its
// description against the Materials and Rental Items catalogs by shared
// significant words. There's no catalogItemId on LineItem and no
// fuzzy-search library/index in this repo, so this is a small in-memory
// scorer, not a database join -- fine given the catalog is a few dozen
// rows (see catalog/materials, catalog/rental-items).
//
// A wrong auto-filled price is worse than a visible $0 that prompts
// review, so the match is deliberately conservative: every one of the
// CANDIDATE catalog item's own significant words must appear in the
// line description (not just some overlap), which means most real RFP
// line descriptions -- "Complete Booth Build 12' x 7' booth..." -- won't
// match anything in a raw-materials/rental catalog at all. That's the
// correct, honest outcome, not a bug to chase with a looser threshold.
// Every match is shown to the reviewer as a labeled suggestion in the
// import preview, never silently applied -- and every imported line
// stays isDraft until a human confirms it, the same gate every other
// document-derived line item goes through.

import { db } from "@/lib/db";

export interface CatalogEntry {
  source: "Material" | "Rental";
  name: string;
  unitCost: number;
  category: string | null;
}

export interface CatalogMatch {
  source: "Material" | "Rental";
  name: string;
  unitCost: number;
  category: string | null;
}

const STOPWORDS = new Set([
  "with", "and", "the", "for", "of", "a", "an", "to", "in", "on", "or", "high", "incl", "including",
]);

function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)) // naive singularize
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export async function loadCatalogForMatching(): Promise<CatalogEntry[]> {
  const [materials, rentals] = await Promise.all([
    db.material.findMany({ where: { deletedAt: null }, select: { name: true, currentUnitCost: true, category: true } }),
    db.rentalItem.findMany({ where: { deletedAt: null }, select: { name: true, unitPrice: true, category: true } }),
  ]);

  return [
    ...materials.map((m) => ({ source: "Material" as const, name: m.name, unitCost: Number(m.currentUnitCost), category: m.category })),
    ...rentals.map((r) => ({ source: "Rental" as const, name: r.name, unitCost: Number(r.unitPrice), category: r.category })),
  ];
}

export function matchDescription(description: string, catalog: CatalogEntry[]): CatalogMatch | null {
  const queryTokens = new Set(significantTokens(description));
  if (queryTokens.size === 0) return null;

  let best: { score: number; entry: CatalogEntry } | null = null;
  for (const entry of catalog) {
    const nameTokens = significantTokens(entry.name);
    if (nameTokens.length === 0) continue;
    const allTokensPresent = nameTokens.every((t) => queryTokens.has(t));
    if (!allTokensPresent) continue;

    const score = nameTokens.length / queryTokens.size;
    if (!best || score > best.score) best = { score, entry };
  }

  return best
    ? { source: best.entry.source, name: best.entry.name, unitCost: best.entry.unitCost, category: best.entry.category }
    : null;
}
