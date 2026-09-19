// Best-effort starting price for a pricing-schedule row -- matches its
// description against the unified catalog (CatalogItem) by shared
// significant words, including each item's aliases (other names the same
// item goes by -- another office's name for it, a spelling seen on past
// estimates). There's no fuzzy-search library/index in this repo, so this
// is a small in-memory scorer, not a database join -- fine at a few
// hundred catalog rows.
//
// A wrong auto-filled price is worse than a visible $0 that prompts
// review, so the match is deliberately conservative: every one of the
// CANDIDATE name's own significant words must appear in the line
// description (not just some overlap), which means most real RFP line
// descriptions -- "Complete Booth Build 12' x 7' booth..." -- won't match
// anything in a raw-materials/rental catalog at all. That's the correct,
// honest outcome, not a bug to chase with a looser threshold. Every match
// is shown to the reviewer as a labeled suggestion in the import preview,
// never silently applied -- and every imported line stays isDraft until a
// human confirms it, the same gate every other document-derived line item
// goes through.

import { db } from "@/lib/db";
import type { CatalogItemType } from "@/generated/prisma/enums";

// "Material" / "Rental" / "Service" -- the item's kind, as read by
// line-item-category.ts's resolveAcquisitionMethod (a Rental match means
// it was picked from the rental price list; a Material match is a raw
// fabrication input). Kept as display-friendly strings rather than the
// CatalogItemType enum because they're also shown to the estimator.
export type CatalogSource = "Material" | "Rental" | "Service";

export interface CatalogEntry {
  source: CatalogSource;
  name: string;
  unitCost: number;
  category: string | null;
  catalogItemId?: string;
  catalogNumber?: string;
  // Other names this item also matches on -- see CatalogItemAlias.
  aliases?: string[];
}

export interface CatalogMatch {
  source: CatalogSource;
  name: string;
  unitCost: number;
  category: string | null;
  catalogItemId?: string;
  catalogNumber?: string;
}

const SOURCE_BY_TYPE: Record<CatalogItemType, CatalogSource> = {
  MATERIAL: "Material",
  RENTAL: "Rental",
  SERVICE: "Service",
};

const STOPWORDS = new Set([
  "with", "and", "the", "for", "of", "a", "an", "to", "in", "on", "or", "high", "incl", "including",
]);

// Exported for vendor-match-service.ts -- same tokenizer, different
// scoring algorithm (that module's matching problem is symmetric, this
// one's is asymmetric containment), so both matchers treat text
// identically even though they answer different questions.
export function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)) // naive singularize
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export async function loadCatalogForMatching(): Promise<CatalogEntry[]> {
  const items = await db.catalogItem.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      catalogNumber: true,
      itemType: true,
      name: true,
      unitCost: true,
      unitPrice: true,
      category: { select: { name: true } },
      aliases: { select: { alias: true } },
    },
  });

  // A material's useful number is what it costs us; a rental/service's is
  // what we charge -- the same one-price-per-row the legacy Material /
  // RentalItem tables each carried. An item with neither price set has
  // nothing to suggest, so it's left out rather than matched at $0.
  return items.flatMap((item) => {
    const price = item.itemType === "MATERIAL" ? (item.unitCost ?? item.unitPrice) : (item.unitPrice ?? item.unitCost);
    if (price == null) return [];
    return [
      {
        source: SOURCE_BY_TYPE[item.itemType],
        name: item.name,
        unitCost: Number(price),
        category: item.category.name,
        catalogItemId: item.id,
        catalogNumber: item.catalogNumber,
        aliases: item.aliases.map((a) => a.alias),
      },
    ];
  });
}

export function matchDescription(description: string, catalog: CatalogEntry[]): CatalogMatch | null {
  const queryTokens = new Set(significantTokens(description));
  if (queryTokens.size === 0) return null;

  let best: { score: number; entry: CatalogEntry } | null = null;
  for (const entry of catalog) {
    for (const candidate of [entry.name, ...(entry.aliases ?? [])]) {
      const nameTokens = significantTokens(candidate);
      if (nameTokens.length === 0) continue;
      const allTokensPresent = nameTokens.every((t) => queryTokens.has(t));
      if (!allTokensPresent) continue;

      const score = nameTokens.length / queryTokens.size;
      if (!best || score > best.score) best = { score, entry };
    }
  }

  if (!best) return null;
  const { source, name, unitCost, category, catalogItemId, catalogNumber } = best.entry;
  return { source, name, unitCost, category, catalogItemId, catalogNumber };
}
