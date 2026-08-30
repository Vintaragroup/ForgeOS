// The proposal-facing category taxonomy -- was a hardcoded CANONICAL_
// CATEGORIES constant here, moved to a real Category table (see its
// schema comment) once estimators needed to edit it themselves: add/
// rename/reorder categories, define sub-categories. The functions below
// are the pure heuristics that were always here (catalog-category
// mapping, description-pattern matching, client-owned detection) --
// unchanged in behavior, just no longer typed against a fixed literal
// union. Anything that needs to know what categories currently exist,
// their hierarchy, or their render/subtotal flags now takes a fetched
// `Category[]` as a parameter (db.category.findMany, ordered by
// sortOrder) instead of importing a constant.

import type { Category } from "@/generated/prisma/client";

export function isKnownCategory(categories: Pick<Category, "name">[], value: string | null | undefined): boolean {
  return !!value && categories.some((c) => c.name === value);
}

// Resolves a category's live display name from its stable key (see
// Category.key's schema comment) -- returns null if no live, non-deleted
// category currently holds that key (deleted, or `categories` wasn't
// fetched). Every heuristic below goes through this instead of returning
// a display-name literal directly, so a rename in /catalog/categories can
// never leave a heuristic emitting a stale name: it either resolves to
// whatever the category is currently called, or -- if the key genuinely
// has no match -- returns null, which the category-audit.ts review system
// surfaces rather than silently persisting a wrong guess.
export function resolveCategoryNameFromKey(categories: Pick<Category, "key" | "name">[], key: string): string | null {
  return categories.find((c) => c.key === key)?.name ?? null;
}

// One level of nesting only -- see Category's schema comment on why (the
// proposal PDF/web view only ever render a top-level section with its
// direct children, never grandchildren).
export function getCategoryChildren(categories: Category[], parentName: string): Category[] {
  const parent = categories.find((c) => c.name === parentName);
  if (!parent) return [];
  return categories.filter((c) => c.parentId === parent.id);
}

// Stable key for the seeded "Custom Build / Rental" category -- see
// Category.key's schema comment. Never a display name (that's what broke
// before this existed): resolve it through resolveCategoryNameFromKey at
// the point of use, always against a freshly fetched `categories`.
export const CUSTOM_BUILD_CATEGORY_KEY = "custom_build";

// Stable key for the seeded "Rental Structures" category (renamed from
// "Structure" -- same key, unchanged, per this file's own convention).
// Used when a booth/component section's own EstimateSection.buildType
// resolves it to a Rental Structures item, overriding that line item's
// raw `category` string -- see aggregateByCategory/bucketLineItemsByCategory.
export const RENTAL_STRUCTURES_CATEGORY_KEY = "structure";

// Best-effort mapping from the raw category strings actually observed in
// the Material/RentalItem catalogs (see the "category" column on both
// models) to the canonical list above, by stable key. Catalog categories
// are a mix of finished-goods groupings (Furniture, A/V, Hanging Sign) and
// raw fabrication-input groupings (Acrylic, Wood & Sheet Goods, Hardware &
// Fasteners) -- the latter all fold into Custom Build since they're inputs
// to something Expo fabricates for the job, not a rentable or purchasable
// line in their own right. The "(Standard Rate)" suffix on some rental
// categories is a pricing-model variant, not a distinct category, so it
// maps the same as its base name.
const CATALOG_CATEGORY_KEY_MAP: Record<string, string> = {
  "structure": "structure",
  "bematrix system": "structure",
  "flooring": "flooring",
  "furniture": "furniture",
  "furniture (standard rate)": "furniture",
  "accessories": "accessories",
  "a/v": "audio_visual",
  "a/v (standard rate)": "audio_visual",
  "graphics package": "graphics",
  "printing substrates": "graphics",
  "hanging sign": "signage",
  "design time": "professional_services",
  "electrical": CUSTOM_BUILD_CATEGORY_KEY,
  "acrylic": CUSTOM_BUILD_CATEGORY_KEY,
  "wood & sheet goods": CUSTOM_BUILD_CATEGORY_KEY,
  "hardware & fasteners": CUSTOM_BUILD_CATEGORY_KEY,
  "custom fabrication & millwork": CUSTOM_BUILD_CATEGORY_KEY,
  "metal & extrusion": CUSTOM_BUILD_CATEGORY_KEY,
  "laminate & finishes": CUSTOM_BUILD_CATEGORY_KEY,
  "packing & crating": "shipping",
  "labor": "labor",
  "shipping": "shipping",
  "miscellaneous": "other",
};

export function mapCatalogCategoryToCanonical(
  rawCategory: string | null | undefined,
  categories: Pick<Category, "key" | "name">[],
): string | null {
  if (!rawCategory) return null;
  const key = CATALOG_CATEGORY_KEY_MAP[rawCategory.trim().toLowerCase()];
  return key ? resolveCategoryNameFromKey(categories, key) : null;
}

// scope-line-item-service.ts's AI extraction path (the "Build from all
// analyzed documents" flow) has its own independently-invented category
// list (SCOPE_CATEGORIES) used as that path's EstimateSection.name --
// mapped here too so every line-item creation path in the system
// converges on this one canonical taxonomy instead of each keeping its
// own scheme.
const SCOPE_CATEGORY_KEY_MAP: Record<string, string> = {
  "booth structure & walls": "structure",
  "doors & hardware": "structure",
  "countertops & cable management": "furniture",
  "electrical & lighting": CUSTOM_BUILD_CATEGORY_KEY,
  "fire & life safety": "structure",
  "roof & coverings": "structure",
  "flooring & platforms": "flooring",
  "labor & installation": "labor",
  "documentation & compliance": "professional_services",
  "other": "other",
};

export function mapScopeCategoryToCanonical(
  scopeCategory: string | null | undefined,
  categories: Pick<Category, "key" | "name">[],
): string | null {
  if (!scopeCategory) return null;
  const key = SCOPE_CATEGORY_KEY_MAP[scopeCategory.trim().toLowerCase()];
  return key ? resolveCategoryNameFromKey(categories, key) : null;
}

// design-cost-estimate-import-service.ts's own banner-row category labels
// ("   BeMatrix", "   Wall Panels", "Labor:", ...) -- confirmed against
// every one of the 13 real booth workbooks in
// data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/,
// this is the complete set that ever precedes a real item row. This is a
// MORE reliable signal than mapCatalogCategoryToCanonical or
// inferCategoryFromDescription for this format specifically -- it's the
// vendor's own explicit grouping, not a guess against free-text part
// descriptions ("310mm x 2418mm Frame", "SEG w/ Blackout White - 168
// 15/16\" x 95 1/16\"") that never contain a category-identifying word at
// all, which is exactly why every row from this importer was landing in
// "Other" before this existed (confirmed live: ~527 of 540 Review-tab
// flags on a real estimate were this, not $0 pricing or anything else).
// Deliberately NOT exhaustive -- "Cleaning", "AE % Commission", and the
// section-header banners ("Exhibit Components:", "OPTIONAL ELEMENTS")
// have no confident canonical home and are left to fall through to the
// description heuristic (and, from there, "Other") rather than guessed.
const DESIGN_COST_CATEGORY_KEY_MAP: Record<string, string> = {
  "flooring": "flooring",
  "bematrix": "structure",
  "bematrix accessories": "accessories",
  "wall panels": "structure",
  "graphic panels": "graphics",
  "electrical": CUSTOM_BUILD_CATEGORY_KEY,
  "labor:": "labor",
  "local transportation / material handling:": "shipping",
};

export function mapDesignCostCategoryToCanonical(
  rawCategory: string | null | undefined,
  categories: Pick<Category, "key" | "name">[],
): string | null {
  if (!rawCategory) return null;
  const key = DESIGN_COST_CATEGORY_KEY_MAP[rawCategory.trim().toLowerCase()];
  return key ? resolveCategoryNameFromKey(categories, key) : null;
}

// Fallback for descriptions that never match the catalog at all -- real
// RFP pricing-schedule line descriptions ("Complete Booth Build 12' x 7'
// booth...") routinely don't, by catalog-match-service.ts's own design
// (deliberately conservative matching). Order matters: first pattern that
// matches wins, most-specific first. A matched pattern whose key has no
// live category returns null immediately rather than trying the next,
// weaker pattern -- preserves most-specific-wins semantics instead of
// letting a worse match silently win when a category's been deleted.
const DESCRIPTION_PATTERNS: { pattern: RegExp; key: string }[] = [
  { pattern: /\b(on[\s-]?site labor|installation|dismantle|labor)\b/i, key: "labor" },
  { pattern: /\bshipping|drayage|freight\b/i, key: "shipping" },
  { pattern: /\b(cad|engineering|project (coordination|management)|art (proofing|template|set ?up)|electrical layout)\b/i, key: "professional_services" },
  { pattern: /\b(seg fabric|dtp|vinyl wrap|graphic|signage fabric)\b/i, key: "graphics" },
  { pattern: /\bhanging sign\b/i, key: "signage" },
  { pattern: /\bcomplete .* build\b/i, key: CUSTOM_BUILD_CATEGORY_KEY },
  { pattern: /\bplatform|sleeper floor|carpet|padding|visqueen\b/i, key: "flooring" },
  { pattern: /\b(door|frame|backer|panel|wall|b-matrix|roof|curtain)\b/i, key: "structure" },
  { pattern: /\b(chair|table|stool|counter|showcase|sofa)\b/i, key: "furniture" },
  { pattern: /\b(monitor|screen|media player|touchscreen|led)\b/i, key: "audio_visual" },
];

export function inferCategoryFromDescription(
  description: string,
  categories: Pick<Category, "key" | "name">[],
): string | null {
  for (const { pattern, key } of DESCRIPTION_PATTERNS) {
    if (pattern.test(description)) return resolveCategoryNameFromKey(categories, key);
  }
  return null;
}

// A $0.00 line is ambiguous without this -- "not yet priced" and "client
// already owns/supplies this, by design" look identical otherwise. Real
// pricing schedules mark the latter explicitly in the description itself
// ("Hanging Sign Fabric - Client Owned", "DTP Corp ID @ 2M Reception
// Counter - Existing"), so this only needs to recognize that existing
// convention, not invent a new one. Deliberately narrow (the literal
// phrase "client owned", or "- existing"/"(existing)" as a trailing
// qualifier) -- a false negative just leaves a $0.00 item unlabeled
// (today's status quo), while a loose pattern risks mislabeling a
// genuinely unpriced draft item as client-supplied.
const CLIENT_OWNED_PATTERN = /\bclient[\s-]?owned\b|[-(]\s*existing\s*\)?$/i;

export function inferIsClientOwned(description: string): boolean {
  return CLIENT_OWNED_PATTERN.test(description.trim());
}

// A multi-line description ("Complete Booth Build\n12' x 7' booth\n8' high
// back & sides..." or "Integrated into above build (Refer to
// Drawings)\n10' - 6" x 25' booth\n...") is a whole-assembly narrative --
// dimensions, wall heights, door placement, often several hundred
// characters -- not a single catalog-priced component. Every multi-line
// description observed in real pricing schedules is one of these; single-
// line descriptions are the catalog-matchable parts. catalog-match-
// service.ts's matching only requires a candidate's own words to all
// appear somewhere in the query text -- against a paragraph this long
// it's prone to spuriously matching on one stray word (e.g. "door"
// mentioned in passing) and mislabeling the whole assembly by whatever
// that word's catalog category happens to be, rather than what the line
// item actually is. Checked first, ahead of any catalog match, for that
// reason -- every single-line description still prefers the catalog's
// own category when one exists. Matches proposal-pdf.tsx's isAssembly --
// same signal, same reason: these render as individually itemized rows
// no matter the detail mode, since collapsing them would hide distinct
// booths, not just repeated parts.
export function isCompoundAssemblyDescription(description: string): boolean {
  return description.includes("\n");
}

// Priority order: an estimator's explicit choice wins outright; then the
// compound-assembly override above; then a confident catalog match's own
// category; then the description heuristic as a last resort. Returns
// null (not "Other") when nothing resolves -- "Other" is a
// presentation-layer bucket for unresolved items, not a category to
// persist as if it were a real determination.
//
// `categories` defaults to [] for callers that only need explicit
// validation, but every other branch is now load-bearing on it (see
// resolveCategoryNameFromKey) -- a caller that forgets to pass a real,
// freshly fetched `categories` will get null back instead of a category,
// which is deliberate: an honestly-uncategorized item gets caught by
// category-audit.ts, a silently-stale name would not have been.
export function resolveLineItemCategory(
  input: {
    explicit?: string | null;
    catalogCategory?: string | null;
    description: string;
  },
  categories: Pick<Category, "key" | "name">[] = [],
): string | null {
  if (input.explicit && isKnownCategory(categories, input.explicit)) return input.explicit;
  if (isCompoundAssemblyDescription(input.description)) {
    return resolveCategoryNameFromKey(categories, CUSTOM_BUILD_CATEGORY_KEY);
  }
  const fromCatalog = mapCatalogCategoryToCanonical(input.catalogCategory, categories);
  if (fromCatalog) return fromCatalog;
  return inferCategoryFromDescription(input.description, categories);
}
