// Cut-list phase 2: packs a material's CutListParts onto its stock sheet
// size using maxrects-packer (the MaxRects 2D bin-packing heuristic --
// see cutlistplus.com's own "cutting diagram optimization," the feature
// this whole cut-list effort emulates). One packer run per material --
// a version's different materials never share a sheet, so they're
// optimized independently.
//
// Two real behaviors of the library, confirmed empirically (not assumed
// from its docs) before writing this:
//
// 1. Per-Rectangle `allowRotation` genuinely works for placement-
//    efficiency decisions (the packer will rotate a part on its own to
//    slot into leftover space when doing so helps, and only for parts
//    that allow it) -- this is what grainConstrained relies on.
// 2. The library's own "oversized" check compares a rect's AS-GIVEN
//    width/height against the bin's maxWidth/maxHeight and does NOT try
//    the rotated orientation first. A part entered "long side first"
//    relative to the sheet's own orientation -- an entirely ordinary way
//    for someone to type in dimensions -- gets silently misclassified as
//    too big for the sheet and dumped into its own oversized single-part
//    bin, instead of being rotated and packed normally. Verified live:
//    a 90x10 part fed to a 48x96 sheet produced a phantom "90x10" bin;
//    pre-swapping to 10x90 before adding placed it correctly. So this
//    file pre-checks both orientations and swaps itself -- see
//    resolvePlacementOrientation -- rather than trusting the library to
//    find the fit.

import { MaxRectsPacker, Rectangle } from "maxrects-packer";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export interface PlacedPart {
  cutListPartId: string;
  x: number;
  y: number;
  // As-placed dimensions (post any rotation) -- not the part's
  // originally entered width/length. A renderer (phase 3) draws
  // straight from these.
  width: number;
  height: number;
  // True if this instance's final orientation differs from how the part
  // was entered, whether because it only fit the sheet rotated or
  // because the packer chose to rotate it for a tighter fit.
  rotated: boolean;
}

// Decides, once, whether a part needs to be pre-swapped before it's
// handed to the packer -- see the file header for why this can't be left
// to the library itself. Throws when a grain-constrained part only fits
// rotated (a genuine "can't be cut from this stock as specified," not
// something to silently reorient) or doesn't fit in either orientation.
function resolvePlacementOrientation(
  part: { description: string; width: number; length: number; grainConstrained: boolean },
  stockWidth: number,
  stockLength: number,
): { width: number; height: number; preRotated: boolean } {
  const fitsAsEntered = part.width <= stockWidth && part.length <= stockLength;
  const fitsSwapped = part.length <= stockWidth && part.width <= stockLength;

  if (fitsAsEntered) return { width: part.width, height: part.length, preRotated: false };

  if (!fitsSwapped) {
    throw new Error(
      `"${part.description}" (${part.width}x${part.length}) is larger than the stock (${stockWidth}x${stockLength}) in every orientation.`,
    );
  }
  if (part.grainConstrained) {
    throw new Error(
      `"${part.description}" only fits this sheet rotated, but its grain direction is constrained -- it can't be cut from this stock as specified.`,
    );
  }
  return { width: part.length, height: part.width, preRotated: true };
}

// Explicitly triggered (a future "Optimize" button, or a caller building
// a full cut list), same posture as scope-line-item-service.ts's own
// header comment on Propose -- never run implicitly as a side effect of
// adding a part, so editing a parts list doesn't silently re-cost an
// expensive-feeling operation on every keystroke (this one's cheap/local,
// no AI call, but the explicit-trigger discipline is worth keeping
// consistent across the app regardless).
export async function optimizeNestingForMaterial(
  estimateVersionId: string,
  materialId: string,
): Promise<PlacedPart[][]> {
  const material = await db.material.findUniqueOrThrow({ where: { id: materialId } });
  if (material.materialType !== "SHEET" || !material.stockWidth || !material.stockLength) {
    throw new Error(
      `"${material.name}" isn't set up as sheet stock yet -- set its material type to Sheet and fill in stock width/length first.`,
    );
  }
  const stockWidth = material.stockWidth.toNumber();
  const stockLength = material.stockLength.toNumber();
  const kerf = material.defaultKerf?.toNumber() ?? 0;

  const parts = await db.cutListPart.findMany({
    where: { estimateVersionId, materialId, deletedAt: null },
  });

  if (parts.length === 0) {
    await db.cutSheet.deleteMany({ where: { estimateVersionId, materialId } });
    return [];
  }

  // padding (the packer's 3rd constructor arg) is spacing applied
  // between every placed rect -- kerf is exactly that, the material
  // actually lost to each cut, so this is the real mechanism, not a
  // manual per-rect inflate-then-shrink-back workaround.
  const packer = new MaxRectsPacker(stockWidth, stockLength, kerf, {
    smart: false, // fixed real stock size, not a "shrink to fit" texture atlas
    pot: false, // no power-of-2 sizing -- this isn't a texture atlas
    square: false,
  });

  for (const part of parts) {
    if (part.width == null) {
      throw new Error(`"${part.description}" has no width set -- a sheet-good part needs both width and length.`);
    }
    const { width, height, preRotated } = resolvePlacementOrientation(
      { description: part.description, width: part.width.toNumber(), length: part.length.toNumber(), grainConstrained: part.grainConstrained },
      stockWidth,
      stockLength,
    );

    for (let i = 0; i < part.qty; i++) {
      const rect = new Rectangle(width, height, 0, 0, false, !part.grainConstrained);
      rect.data = { cutListPartId: part.id, preRotated };
      packer.add(rect);
    }
  }

  const placedByBin: PlacedPart[][] = packer.bins.map((bin) =>
    bin.rects.map((r) => ({
      cutListPartId: (r.data as { cutListPartId: string }).cutListPartId,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      // XOR of "did we pre-swap it before adding" and "did the packer
      // additionally rotate it for placement" -- both are real
      // orientation changes away from what was entered, and either one
      // alone (not both) means the final placement is rotated.
      rotated: (r.data as { preRotated: boolean }).preRotated !== r.rot,
    })),
  );

  await db.cutSheet.deleteMany({ where: { estimateVersionId, materialId } });
  await db.$transaction(
    placedByBin.map((layout, i) =>
      db.cutSheet.create({
        data: {
          estimateVersionId,
          materialId,
          sheetNumber: i + 1,
          layout: layout as unknown as Prisma.InputJsonValue,
        },
      }),
    ),
  );

  return placedByBin;
}

// Convenience wrapper for a full cut list -- finds every distinct
// SHEET-type material actually used in this version's parts and
// optimizes each independently, same "one action covers everything"
// shape as estimate-synthesis-service.ts's buildEstimateFromAllDocuments.
// A LINEAR material (board stock cut to length, a different 1D problem
// than 2D sheet nesting) or a part on a material that isn't set up as
// stock yet is reported as skipped rather than failing the whole run.
export interface OptimizeAllResult {
  optimized: { materialId: string; materialName: string; sheetCount: number }[];
  skipped: { materialId: string; materialName: string; reason: string }[];
}

export async function optimizeNestingForVersion(estimateVersionId: string): Promise<OptimizeAllResult> {
  const materialIds = await db.cutListPart.findMany({
    where: { estimateVersionId, deletedAt: null },
    select: { materialId: true },
    distinct: ["materialId"],
  });

  const optimized: OptimizeAllResult["optimized"] = [];
  const skipped: OptimizeAllResult["skipped"] = [];

  for (const { materialId } of materialIds) {
    const material = await db.material.findUniqueOrThrow({ where: { id: materialId } });
    try {
      const sheets = await optimizeNestingForMaterial(estimateVersionId, materialId);
      optimized.push({ materialId, materialName: material.name, sheetCount: sheets.length });
    } catch (err) {
      skipped.push({ materialId, materialName: material.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { optimized, skipped };
}
