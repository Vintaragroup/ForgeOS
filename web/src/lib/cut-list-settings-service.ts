// Cut-list phase 7: shop-wide defaults for the nesting engine and the
// diagram editor -- see CutListSettings's own schema comment for why
// this is a genuinely new concept in this app (no other model represents
// app-wide/singleton configuration). getCutListSettings lazily creates
// the one row on first read (with the schema's own column defaults, so
// nothing behaves differently until someone actually edits the panel),
// rather than requiring a manual seed step.
import { db } from "@/lib/db";
import type { CutListSettings } from "@/generated/prisma/client";

export async function getCutListSettings(): Promise<CutListSettings> {
  const existing = await db.cutListSettings.findFirst();
  if (existing) return existing;
  return db.cutListSettings.create({ data: {} });
}

export async function updateCutListSettings(data: {
  defaultKerf: number;
  minRemnantDimension: number;
  dragGridSnap: number;
}): Promise<CutListSettings> {
  const settings = await getCutListSettings();
  return db.cutListSettings.update({ where: { id: settings.id }, data });
}
