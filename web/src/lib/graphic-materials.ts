// The substrates Graphics prints on, and the spellings to fold into them.
//
// Seeded from the 20 distinct values in the PGA control log -- the only
// real material vocabulary we have, since the Microsoft List tracker
// carries no material column at all.
//
// A leaf module: no db import, so a picker and an import script share one
// list.

export type GraphicMaterialClass = "FABRIC" | "RIGID" | "HANGING_SIGN";

export interface MaterialSeed {
  name: string;
  materialClass: GraphicMaterialClass;
  // Offered in the picker. False for a value that is real history but
  // shouldn't be chosen again.
  isActive: boolean;
  // Spellings found in the data that mean this material. Used once, by
  // the backfill -- once history is normalised and the picker is in
  // place, no new variants can appear, so aliases are a migration concern
  // rather than something to carry in the schema.
  aliases?: string[];
  note?: string;
}

// Ordered as a sign shop would scan them: the two workhorses first, then
// the rest by how often the log uses them.
export const MATERIAL_SEEDS: MaterialSeed[] = [
  { name: 'PVC (White) - 1/8"', materialClass: "RIGID", isActive: true },
  { name: "Fabric (Black-Back)", materialClass: "FABRIC", isActive: true },
  { name: "Vinyl (White)", materialClass: "RIGID", isActive: true },
  { name: 'PVC (Black) - 1/8"', materialClass: "RIGID", isActive: true },
  { name: "Vinyl (Black)", materialClass: "RIGID", isActive: true },
  { name: "Vinyl (RTA)", materialClass: "RIGID", isActive: true },
  { name: "PVC (Black) - 6mm", materialClass: "RIGID", isActive: true },
  { name: "PVC (White) - 6mm", materialClass: "RIGID", isActive: true },
  { name: '1" Ultraboard - White', materialClass: "RIGID", isActive: true },
  { name: "Fabric (Eco - Gray back)", materialClass: "FABRIC", isActive: true },
  { name: "Fabric (Lightbox)", materialClass: "FABRIC", isActive: true },
  // Misspelled as "Acrlyic" on 3 of the 5 acrylic rows in the log.
  { name: "Acrylic / Plexi (Frost)", materialClass: "RIGID", isActive: true, aliases: ["Acrlyic / Plexi (Frost)"] },
  {
    name: 'Acrylic / Plexi (Clear) - 1/2"',
    materialClass: "RIGID",
    isActive: true,
    aliases: ['Acrlyic / Plexi (Clear) - 1/2"'],
  },
  {
    name: 'Acrylic / Plexi (Clear) - 3/16"',
    materialClass: "RIGID",
    isActive: true,
    aliases: ['Acrlyic / Plexi (Clear) - 3/16"'],
  },
  {
    name: 'Acrylic / Plexi (Milk) - 1/8"',
    materialClass: "RIGID",
    isActive: true,
    aliases: ['Acrlyic / Plexi (Milk) - 1/8"'],
  },
  // The log capitalises this two ways.
  { name: 'Foamboard - 3/16"', materialClass: "RIGID", isActive: true, aliases: ['FoamBoard - 3/16"'] },
  { name: 'Foamboard - 1/2"', materialClass: "RIGID", isActive: true, aliases: ['FoamBoard - 1/2"'] },
  { name: "Sintra", materialClass: "RIGID", isActive: true },
  { name: "Scrim", materialClass: "FABRIC", isActive: true },
  {
    name: "Hanging Sign",
    materialClass: "HANGING_SIGN",
    isActive: false,
    note: "Describes the piece, not what it is printed on. Kept so one historical row still classifies correctly; not offered.",
  },
];

// Loose enough to fold the variants the log actually contains -- case,
// spacing and punctuation -- without merging two genuinely different
// substrates. Thickness stays significant: 1/8" PVC is not 6mm PVC.
export function normalizeMaterialName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9/."]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BY_NORMALIZED = new Map<string, string>();
for (const seed of MATERIAL_SEEDS) {
  BY_NORMALIZED.set(normalizeMaterialName(seed.name), seed.name);
  for (const alias of seed.aliases ?? []) BY_NORMALIZED.set(normalizeMaterialName(alias), seed.name);
}

// The canonical spelling for a value found in the wild, or null when it
// matches nothing known -- which is a value for a human to look at, not
// one to invent a material from.
export function canonicalMaterialName(raw: string | null | undefined): string | null {
  const value = `${raw ?? ""}`.trim();
  if (!value) return null;
  return BY_NORMALIZED.get(normalizeMaterialName(value)) ?? null;
}

export function materialClassOf(name: string | null | undefined): GraphicMaterialClass | null {
  const canonical = canonicalMaterialName(name);
  if (!canonical) return null;
  return MATERIAL_SEEDS.find((s) => s.name === canonical)?.materialClass ?? null;
}
