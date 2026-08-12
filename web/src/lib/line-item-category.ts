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

// One level of nesting only -- see Category's schema comment on why (the
// proposal PDF/web view only ever render a top-level section with its
// direct children, never grandchildren).
export function getCategoryChildren(categories: Category[], parentName: string): Category[] {
  const parent = categories.find((c) => c.name === parentName);
  if (!parent) return [];
  return categories.filter((c) => c.parentId === parent.id);
}

// Best-effort mapping from the raw category strings actually observed in
// the Material/RentalItem catalogs (see the "category" column on both
// models) to the canonical list above. Catalog categories are a mix of
// finished-goods groupings (Furniture, A/V, Hanging Sign) and raw
// fabrication-input groupings (Acrylic, Wood & Sheet Goods, Hardware &
// Fasteners) -- the latter all fold into "Custom Build" since they're
// inputs to something Expo fabricates for the job, not a rentable or
// purchasable line in their own right. The "(Standard Rate)" suffix on
// some rental categories is a pricing-model variant, not a distinct
// category, so it maps the same as its base name.
const CATALOG_CATEGORY_MAP: Record<string, string> = {
  "structure": "Structure",
  "bematrix system": "Structure",
  "flooring": "Flooring",
  "furniture": "Furniture",
  "furniture (standard rate)": "Furniture",
  "accessories": "Accessories",
  "a/v": "Audio/Visual",
  "a/v (standard rate)": "Audio/Visual",
  "graphics package": "Graphics",
  "printing substrates": "Graphics",
  "hanging sign": "Signage",
  "design time": "Professional Services",
  "electrical": "Custom Build",
  "acrylic": "Custom Build",
  "wood & sheet goods": "Custom Build",
  "hardware & fasteners": "Custom Build",
  "custom fabrication & millwork": "Custom Build",
  "metal & extrusion": "Custom Build",
  "laminate & finishes": "Custom Build",
  "packing & crating": "Shipping",
  "labor": "Labor",
  "shipping": "Shipping",
  "miscellaneous": "Other",
};

export function mapCatalogCategoryToCanonical(rawCategory: string | null | undefined): string | null {
  if (!rawCategory) return null;
  return CATALOG_CATEGORY_MAP[rawCategory.trim().toLowerCase()] ?? null;
}

// scope-line-item-service.ts's AI extraction path (the "Build from all
// analyzed documents" flow) has its own independently-invented category
// list (SCOPE_CATEGORIES) used as that path's EstimateSection.name --
// mapped here too so every line-item creation path in the system
// converges on this one canonical taxonomy instead of each keeping its
// own scheme.
const SCOPE_CATEGORY_MAP: Record<string, string> = {
  "booth structure & walls": "Structure",
  "doors & hardware": "Structure",
  "countertops & cable management": "Furniture",
  "electrical & lighting": "Custom Build",
  "fire & life safety": "Structure",
  "roof & coverings": "Structure",
  "flooring & platforms": "Flooring",
  "labor & installation": "Labor",
  "documentation & compliance": "Professional Services",
  "other": "Other",
};

export function mapScopeCategoryToCanonical(scopeCategory: string | null | undefined): string | null {
  if (!scopeCategory) return null;
  return SCOPE_CATEGORY_MAP[scopeCategory.trim().toLowerCase()] ?? null;
}

// Fallback for descriptions that never match the catalog at all -- real
// RFP pricing-schedule line descriptions ("Complete Booth Build 12' x 7'
// booth...") routinely don't, by catalog-match-service.ts's own design
// (deliberately conservative matching). Order matters: first pattern that
// matches wins, most-specific first.
const DESCRIPTION_PATTERNS: { pattern: RegExp; category: string }[] = [
  { pattern: /\b(on[\s-]?site labor|installation|dismantle|labor)\b/i, category: "Labor" },
  { pattern: /\bshipping|drayage|freight\b/i, category: "Shipping" },
  { pattern: /\b(cad|engineering|project (coordination|management)|art (proofing|template|set ?up)|electrical layout)\b/i, category: "Professional Services" },
  { pattern: /\b(seg fabric|dtp|vinyl wrap|graphic|signage fabric)\b/i, category: "Graphics" },
  { pattern: /\bhanging sign\b/i, category: "Signage" },
  { pattern: /\bcomplete .* build\b/i, category: "Custom Build" },
  { pattern: /\bplatform|sleeper floor|carpet|padding|visqueen\b/i, category: "Flooring" },
  { pattern: /\b(door|frame|backer|panel|wall|b-matrix)\b/i, category: "Structure" },
  { pattern: /\b(chair|table|stool|counter|showcase|sofa)\b/i, category: "Furniture" },
  { pattern: /\b(monitor|screen|media player|touchscreen|led)\b/i, category: "Audio/Visual" },
];

export function inferCategoryFromDescription(description: string): string | null {
  for (const { pattern, category } of DESCRIPTION_PATTERNS) {
    if (pattern.test(description)) return category;
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
// `categories` defaults to [] -- only needed to validate `explicit`
// against the live catalog; callers that never pass `explicit` (e.g.
// pricing-import-service.ts, which only ever supplies catalogCategory +
// description) don't need to fetch/pass it.
export function resolveLineItemCategory(
  input: {
    explicit?: string | null;
    catalogCategory?: string | null;
    description: string;
  },
  categories: Pick<Category, "name">[] = [],
): string | null {
  if (input.explicit && isKnownCategory(categories, input.explicit)) return input.explicit;
  if (isCompoundAssemblyDescription(input.description)) return "Custom Build";
  const fromCatalog = mapCatalogCategoryToCanonical(input.catalogCategory);
  if (fromCatalog) return fromCatalog;
  return inferCategoryFromDescription(input.description);
}
