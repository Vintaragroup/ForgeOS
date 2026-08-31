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
import type { SectionBuildType } from "@/generated/prisma/enums";

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

// Stable key for the seeded "Misc" type category -- IT equipment,
// special-request equipment, anything that doesn't cleanly fit
// Structure/Flooring/Furniture/Audio-Visual. New alongside the Type x
// Method taxonomy below; every other Type key (structure/flooring/
// furniture/audio_visual) already existed before this.
export const MISC_CATEGORY_KEY = "misc";

// The five real commodity Types that get a Rental/Purchase/Custom
// Fabricated split (per direct confirmation: every Type can appear under
// every Method -- a client can rent, purchase, or get custom-built A/V
// gear same as furniture or structure). Custom Build is deliberately
// NOT in this list -- it stays a flat catch-all for fabrication inputs
// that don't cleanly resolve to one of these five, not itself split by
// Method (see MethodKey's own comment on why "Custom Build" and
// "Custom Fabricated" are different things: one is a Type, the other a
// Method that composes onto a Type).
export const TYPE_KEYS_WITH_METHOD_SPLIT = [
  RENTAL_STRUCTURES_CATEGORY_KEY,
  "flooring",
  "furniture",
  "audio_visual",
  MISC_CATEGORY_KEY,
] as const;

export type MethodKey = "rental" | "purchase" | "custom_fabricated";

// Display label for a Method, derived from a leaf category's stable `key`
// suffix (never its estimator-editable `name`) -- see
// proposal-view-model.ts's groupPrimaryCategoryTabs, the one place this is
// used to label the category board's secondary Method pill filter.
export const METHOD_KEY_LABELS: Record<MethodKey, string> = {
  rental: "Rental",
  purchase: "Purchase",
  custom_fabricated: "Custom Fabricated",
};

export function methodKeyFromBuildType(buildType: SectionBuildType): MethodKey {
  if (buildType === "RENTAL") return "rental";
  if (buildType === "PURCHASE") return "purchase";
  return "custom_fabricated";
}

// Composes a Type key (structure/flooring/furniture/audio_visual/misc/
// custom_build) and an optional Method into the stable key of the live
// leaf category that combination resolves to, e.g. ("structure",
// "RENTAL") -> "structure_rental". A null method (nothing resolved it
// yet -- see resolveAcquisitionMethod) resolves to the flat Type key
// itself, unchanged -- an item whose Method hasn't resolved renders
// under its Type with no Method split, never a guessed leaf. Always
// resolve the returned key through resolveCategoryNameFromKey before
// display -- this only ever returns a key, never a name.
export function leafCategoryKey(typeKey: string, method: SectionBuildType | null): string {
  return method ? `${typeKey}_${methodKeyFromBuildType(method)}` : typeKey;
}

// Infers a line item's acquisition Method from real signals in its own
// raw import data -- confirmed directly against the estimator's own
// rules:
// - BeMatrix is always rental hardware, regardless of catalog or import
//   path (confirmed real recurring raw-text signal across multiple
//   importers already -- see ELEMENT_TYPE_MAP in proposal-view-model.ts,
//   DESIGN_COST_CATEGORY_KEY_MAP below).
// - A RentalItem catalog match (catalog-match-service.ts's own
//   `source: "Rental"`, as opposed to a Material catalog match) means
//   the estimator picked it from the rental price list, not a
//   fabrication-input list -- "if they select furniture from our
//   catalog its rental" generalizes to any RentalItem match, not just
//   furniture.
// - Explicit "rental" text covers a vendor bid marked "market rental"
//   or similar phrasing.
// - Explicit "purchase"/"purchased" text -- confirmed real: a genuine
//   Chicago vendor workbook row reads "PURCHASE SQ FT (basic) —
//   ceiling" (module-cost-estimate-import-service.test.ts).
// - A Material catalog match with no stronger signal falls back to
//   Custom Fabricated -- it's a raw fabrication input (same reasoning
//   CATALOG_CATEGORY_KEY_MAP already applies for Type: Acrylic/Wood &
//   Sheet Goods/Hardware & Fasteners all fold into Custom Build).
// Returns null (never guesses) when nothing matches -- same "don't
// persist a guess" philosophy as resolveLineItemCategory's own null
// fallback; an unresolved Method just means "not split yet," not "no
// category at all."
export function resolveAcquisitionMethod(input: {
  catalogSource?: "Material" | "Rental";
  category?: string | null;
  description: string;
}): SectionBuildType | null {
  const text = `${input.category ?? ""} ${input.description}`;
  if (/\bbematrix\b|\bbe[\s-]matrix\b|\bb-matrix\b/i.test(text)) return "RENTAL";
  if (input.catalogSource === "Rental") return "RENTAL";
  if (/\brental\b/i.test(text)) return "RENTAL";
  if (/\bpurchase(d)?\b/i.test(text)) return "PURCHASE";
  if (input.catalogSource === "Material") return "CUSTOM_BUILD";
  return null;
}

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
  { pattern: /\b(seg|dtp|vinyl wrap|graphic|signage fabric)\b/i, key: "graphics" },
  { pattern: /\bhanging sign\b/i, key: "signage" },
  { pattern: /\bcomplete .* build\b/i, key: CUSTOM_BUILD_CATEGORY_KEY },
  // "platform"/"sleeper floor"/"scaffold"/"truss" checked as structure
  // BEFORE the flooring pattern below -- confirmed live as a real bug:
  // a temporary-structure job's "Platform for Booth", "Sleeper Floor
  // incl curb ramp" line items (scaffolding/platform-build parts, not
  // floor coverings) were matching flooring's own broader pattern first,
  // landing an entire scaffolding job's real pricing under Flooring.
  // Genuine floor coverings (carpet, padding, visqueen) still resolve
  // to flooring via the pattern below, since this one doesn't claim them.
  { pattern: /\b(door|frame|backer|panel|wall|b-matrix|bematrix|roof|curtain|platform|sleeper floor|scaffold|scaffolding|truss)\b/i, key: "structure" },
  { pattern: /\bcarpet|padding|visqueen\b/i, key: "flooring" },
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

// SEG (Silicone Edge Graphics fabric) is unambiguous -- per direct
// confirmation, it's always Graphics, and always a purchase/throwaway
// (never pulled from rental stock, since Graphics isn't one of the Types
// with a real Rental/Purchase split -- see TYPE_KEYS_WITH_METHOD_SPLIT).
// Checked as a dedicated, higher-priority signal in
// resolveLineItemTypeKey below rather than relying solely on
// DESCRIPTION_PATTERNS' own (lower-priority, catalog-match-losing) graphics
// entry -- confirmed live as a real miscategorization: a booth-workbook
// import's section-banner mapping (design-cost-estimate-import-service.ts)
// routes an entire "Wall Panels" banner group to Structure, including its
// SEG fabric lines, before any per-item description check ever runs. This
// export lets that importer (and anywhere else that needs the same
// override ahead of its own category-resolution order) apply the same
// rule explicitly.
//
// Bare "SEG" as a whole word, deliberately -- an earlier, narrower version
// of this pattern required a nearby marker word ("fabric"/"graphic"/
// "panel"/"wall"/"w/") specifically to exclude one item that looked like a
// false positive ("Custom SEG structure resembling a golf tee"). Reviewing
// 363 real SEG line items across 4 real shows disproved that: genuine SEG
// fabric phrasing varies far too widely in real vendor data ("SEG BACKLIT
// -- ceiling", "SEG -- Return Walls Both Faces -- 7.83' x 10'", "SEG
// White - SCRIM", "Large back-wall graphic, SEG-mounted") for any nearby-
// marker requirement to reliably catch it -- the narrower pattern missed
// 68 of those 363 genuine items. Per direct confirmation, "SEG" has no
// other meaning in this business, so a bare word-boundary match (still
// won't false-positive on "segment") is both simpler and more correct.
const ALWAYS_GRAPHICS_PATTERN = /\bseg\b/i;

export function isAlwaysGraphicsDescription(description: string): boolean {
  return ALWAYS_GRAPHICS_PATTERN.test(description);
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
// compound-assembly override above; then the always-Graphics SEG override
// (isAlwaysGraphicsDescription -- still below explicit/assembly, since a
// human's own choice or a genuine multi-line assembly narrative that just
// mentions SEG in passing should both still win); then a confident catalog
// match's own category; then the description heuristic as a last resort.
// Returns null (not "Other") when nothing resolves -- "Other" is a
// presentation-layer bucket for unresolved items, not a category to
// persist as if it were a real determination.
//
// `categories` defaults to [] for callers that only need explicit
// validation, but every other branch is now load-bearing on it (see
// resolveCategoryNameFromKey) -- a caller that forgets to pass a real,
// freshly fetched `categories` will get null back instead of a category,
// which is deliberate: an honestly-uncategorized item gets caught by
// category-audit.ts, a silently-stale name would not have been.
// Key-returning sibling of resolveLineItemCategory below, same priority
// chain (explicit > compound-assembly override > SEG override > catalog
// match > description heuristic) but stopping one step short of resolving
// to a live display name -- needed so a caller can compose this Type key
// with a separately-resolved Method key (leafCategoryKey) before the one
// resolveCategoryNameFromKey lookup that actually hits the live
// category list. resolveLineItemCategory itself is now a thin wrapper
// around this -- no behavior change for any existing caller.
export function resolveLineItemTypeKey(
  input: {
    explicit?: string | null;
    catalogCategory?: string | null;
    description: string;
  },
  categories: Pick<Category, "key" | "name">[] = [],
): string | null {
  if (input.explicit && isKnownCategory(categories, input.explicit)) {
    return categories.find((c) => c.name === input.explicit)?.key ?? null;
  }
  if (isCompoundAssemblyDescription(input.description)) return CUSTOM_BUILD_CATEGORY_KEY;
  if (isAlwaysGraphicsDescription(input.description)) return "graphics";
  const catalogKey = CATALOG_CATEGORY_KEY_MAP[(input.catalogCategory ?? "").trim().toLowerCase()];
  if (catalogKey) return catalogKey;
  for (const { pattern, key } of DESCRIPTION_PATTERNS) {
    if (pattern.test(input.description)) return key;
  }
  return null;
}

export function resolveLineItemCategory(
  input: {
    explicit?: string | null;
    catalogCategory?: string | null;
    description: string;
  },
  categories: Pick<Category, "key" | "name">[] = [],
): string | null {
  if (input.explicit && isKnownCategory(categories, input.explicit)) return input.explicit;
  const key = resolveLineItemTypeKey(input, categories);
  return key ? resolveCategoryNameFromKey(categories, key) : null;
}

// The one place Type and Method come together into a real, resolved
// Category.name -- used at import time (pricing-import-service.ts,
// where a real catalogSource is available from the match that just
// happened) and reused by the bucketing layer's own effective-category
// resolution (proposal-view-model.ts's resolveEffectiveCategory) once a
// section's tag supplies Method instead of the per-item inference. Type
// always resolves via the existing resolveLineItemTypeKey priority
// chain, completely independent of Method -- this is the fix for a
// tagged component's non-Structure content (Audio/Visual, Graphics, ...)
// disappearing into whichever category the tag names; only the five
// commodity Types with a real Rental/Purchase/Custom Fabricated split
// (TYPE_KEYS_WITH_METHOD_SPLIT) ever compose with Method at all -- a
// Labor/Shipping/Graphics/Custom Build item's Type key passes straight
// through unchanged even when Method resolves to something, since those
// Types were never seeded with Method children.
export function resolveComposedCategory(
  input: {
    explicit?: string | null;
    catalogCategory?: string | null;
    catalogSource?: "Material" | "Rental";
    description: string;
    // An explicit Method override (a tagged section's own buildType) --
    // when provided, wins outright and per-item inference never runs.
    // Omit to let resolveAcquisitionMethod infer from this item's own
    // signals instead.
    method?: SectionBuildType;
  },
  categories: Pick<Category, "key" | "name">[] = [],
): string | null {
  if (input.explicit && isKnownCategory(categories, input.explicit)) return input.explicit;
  const typeKey = resolveLineItemTypeKey(input, categories);
  if (!typeKey) return null;
  if (!(TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).includes(typeKey)) {
    return resolveCategoryNameFromKey(categories, typeKey);
  }
  const method = input.method ?? resolveAcquisitionMethod(input);
  const leafKey = leafCategoryKey(typeKey, method);
  return resolveCategoryNameFromKey(categories, leafKey) ?? resolveCategoryNameFromKey(categories, typeKey);
}
