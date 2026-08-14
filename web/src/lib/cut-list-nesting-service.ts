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
import { noOverlap, type PlacedPart } from "@/lib/cut-sheet-geometry";
import { getCutListSettings } from "@/lib/cut-list-settings-service";

// Re-exported (not just imported) so every existing consumer of these
// two names (tests, cut-list/actions.ts) keeps importing from this one
// module as before -- see cut-sheet-geometry.ts's own header comment for
// why the actual definitions had to move out of here: a client component
// (cut-sheet-diagram-editor.tsx) importing noOverlap directly from this
// file would bundle this file's own top-level `db` import (and the `pg`
// Postgres driver with it) into the browser build.
export { noOverlap };
export type { PlacedPart };

// Cut-list phase 6, feature 5: re-validates a manually dragged-and-
// dropped layout server-side (cut-list/actions.ts's
// updateCutSheetLayoutAction) -- never trust client-computed positions
// blindly. Throws a clear Error on the first violation found; returns
// nothing on success. A pure function (no DB access) so it's directly
// testable independent of the action's auth/fetch/persist plumbing.
export function validateManualLayout(
  parts: PlacedPart[],
  existingParts: PlacedPart[],
  sheetWidth: number,
  sheetLength: number,
): void {
  // A manual reposition can only rearrange the parts already placed on
  // this sheet -- never add, remove, or swap which instances are here.
  // Compared as a multiset of cutListPartIds (an instance carries no
  // stable id of its own, so array order can't be trusted).
  const existingIds = existingParts.map((p) => p.cutListPartId).sort();
  const incomingIds = parts.map((p) => p.cutListPartId).sort();
  if (existingIds.length !== incomingIds.length || existingIds.some((id, i) => id !== incomingIds[i])) {
    throw new Error("The submitted layout doesn't match this sheet's real parts -- reload the page and try again.");
  }

  for (const part of parts) {
    if (part.x < 0 || part.y < 0 || part.x + part.width > sheetWidth || part.y + part.height > sheetLength) {
      throw new Error("A part is positioned outside the sheet's bounds -- move it back onto the sheet before saving.");
    }
  }
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (!noOverlap(parts[i], parts[j])) {
        throw new Error("Two parts overlap -- move them apart before saving.");
      }
    }
  }
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

interface Instance {
  cutListPartId: string;
  width: number;
  height: number;
  preRotated: boolean;
  grainConstrained: boolean;
}

// Re-checks a pre-oriented instance (already resolved against the FULL
// sheet size) against a SMALLER bin -- a specific remnant. Allowed to
// swap again if the instance isn't grain-constrained; returns null (not
// an error) when it simply doesn't fit this particular remnant, since
// that's a normal, expected outcome here (try the next remnant, or fall
// through to fresh stock), not the permanent "too big for any stock"
// case resolvePlacementOrientation guards against.
function fitsInBin(inst: Instance, binWidth: number, binHeight: number): { width: number; height: number; rotatedAgain: boolean } | null {
  if (inst.width <= binWidth && inst.height <= binHeight) return { width: inst.width, height: inst.height, rotatedAgain: false };
  if (!inst.grainConstrained && inst.height <= binWidth && inst.width <= binHeight) {
    return { width: inst.height, height: inst.width, rotatedAgain: true };
  }
  return null;
}

// Only the single largest free rectangle, and only above
// minRemnantDimension (a shop-configurable setting -- see
// CutListSettings) -- see the file-level note on why more than one per
// sheet risks double-booking the same physical scrap.
function extractLargestRemnantCandidate(
  freeRects: { width: number; height: number }[],
  minRemnantDimension: number,
): { width: number; length: number } | null {
  let best: { width: number; height: number } | null = null;
  for (const fr of freeRects) {
    if (fr.width < minRemnantDimension || fr.height < minRemnantDimension) continue;
    if (!best || fr.width * fr.height > best.width * best.height) best = fr;
  }
  return best ? { width: best.width, length: best.height } : null;
}

interface BinResult {
  placed: PlacedPart[];
  consumedRemnantId: string | null;
  generatedRemnant: { width: number; length: number } | null;
}

// Packs `instances` into a single bin of the given size, taking ONLY the
// packer's first bin as this attempt's real result -- maxrects-packer
// will silently spawn a SECOND same-sized bin for anything that doesn't
// fit the first (correct behavior for an unlimited supply of fresh
// sheets, wrong here: a specific remnant is one-of-a-kind, there's no
// second copy of it). Anything that spills past the first bin, or
// doesn't individually fit these dimensions at all, is returned as
// still-unplaced for the caller to try elsewhere.
function packOneBin(
  instances: Instance[],
  binWidth: number,
  binHeight: number,
  kerf: number,
  minRemnantDimension: number,
): { result: BinResult; unplaced: Instance[] } {
  const packer = new MaxRectsPacker(binWidth, binHeight, kerf, { smart: false, pot: false, square: false });
  const unplaced: Instance[] = [];
  const attempted: Instance[] = [];

  for (const inst of instances) {
    const fit = fitsInBin(inst, binWidth, binHeight);
    if (!fit) {
      unplaced.push(inst);
      continue;
    }
    const rect = new Rectangle(fit.width, fit.height, 0, 0, false, !inst.grainConstrained);
    // instanceRef carries the exact object identity through the packer
    // so placed-vs-spilled-to-a-phantom-second-bin can be told apart
    // afterward by reference, not by re-deriving it from cutListPartId
    // (multiple instances of the same part share that id).
    rect.data = { cutListPartId: inst.cutListPartId, preRotated: inst.preRotated !== fit.rotatedAgain, instanceRef: inst };
    packer.add(rect);
    attempted.push(inst);
  }

  const firstBin = packer.bins[0];
  // Anything the packer put in a second (phantom, same-sized) bin didn't
  // really fit alongside everything else in this one real remnant --
  // requeue it for the caller to try elsewhere.
  for (const inst of attempted) {
    const placedInFirstBin = firstBin?.rects.some((r) => (r.data as { instanceRef: Instance }).instanceRef === inst);
    if (!placedInFirstBin) unplaced.push(inst);
  }

  const placed: PlacedPart[] = firstBin
    ? firstBin.rects.map((r) => ({
        cutListPartId: (r.data as { cutListPartId: string }).cutListPartId,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        rotated: (r.data as { preRotated: boolean }).preRotated !== r.rot,
      }))
    : [];

  return {
    result: {
      placed,
      consumedRemnantId: null,
      generatedRemnant: firstBin ? extractLargestRemnantCandidate(firstBin.freeRects, minRemnantDimension) : null,
    },
    unplaced,
  };
}

// Explicitly triggered (a future "Optimize" button, or a caller building
// a full cut list), same posture as scope-line-item-service.ts's own
// header comment on Propose -- never run implicitly as a side effect of
// adding a part, so editing a parts list doesn't silently re-cost an
// expensive-feeling operation on every keystroke (this one's cheap/local,
// no AI call, but the explicit-trigger discipline is worth keeping
// consistent across the app regardless).
// Cut-list phase 6 bugfix: every OTHER caller that deletes a material's
// CutSheet rows to clear stale state (addCutListPartAction,
// deleteCutListPartAction in cut-list/actions.ts) did a bare
// `db.cutSheet.deleteMany(...)`, missing this exact cleanup -- a real,
// confirmed-live bug: adding or deleting a part on a material with an
// existing optimized layout threw `Foreign key constraint violated on
// the constraint: material_remnants_generatedByCutSheetId_fkey`, because
// a MaterialRemnant this material's CutSheet had generated still
// referenced it (ON DELETE RESTRICT) and was never cleaned up first.
// optimizeNestingForMaterial had this exact logic inline already (see
// its own header comment on why it must run before availableRemnants is
// read) -- promoted here so every caller that clears a material's old
// CutSheet rows goes through the same one cleanup, not a second
// (previously missing) copy.
export async function clearStaleCutSheets(estimateVersionId: string, materialId: string): Promise<void> {
  const oldSheets = await db.cutSheet.findMany({ where: { estimateVersionId, materialId } });
  if (oldSheets.length === 0) return;
  const oldConsumedRemnantIds = oldSheets.map((s) => s.consumedRemnantId).filter((id): id is string => id != null);
  const oldSheetIds = oldSheets.map((s) => s.id);

  await db.$transaction(async (tx) => {
    if (oldConsumedRemnantIds.length > 0) {
      await tx.materialRemnant.updateMany({ where: { id: { in: oldConsumedRemnantIds } }, data: { consumedAt: null } });
    }
    await tx.materialRemnant.deleteMany({ where: { generatedByCutSheetId: { in: oldSheetIds } } });
    await tx.cutSheet.deleteMany({ where: { id: { in: oldSheetIds } } });
  });
}

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
  // Material.defaultKerf (set per-material on its own catalog page)
  // always wins when present; CutListSettings.defaultKerf is only the
  // shop-wide fallback for a material that hasn't been given its own
  // real value yet -- see the settings panel (catalog/cut-list-settings).
  const settings = await getCutListSettings();
  const kerf = material.defaultKerf?.toNumber() ?? settings.defaultKerf.toNumber();
  const minRemnantDimension = settings.minRemnantDimension.toNumber();

  const parts = await db.cutListPart.findMany({
    where: { estimateVersionId, materialId, deletedAt: null },
  });

  // Every old CutSheet for this material+version is about to be
  // superseded regardless of whether there are still parts to place --
  // clean up what it did to the shop-wide remnant pool BEFORE anything
  // below reads availableRemnants: give back any remnant it consumed
  // (it's available again), and remove any remnant it generated (a
  // fresh one gets computed below if parts remain, and a stale one
  // describing a layout that no longer exists shouldn't linger either
  // way). This MUST run before the availableRemnants query further
  // down, not after packing -- reading it first would either miss a
  // remnant this same material's previous run had consumed (now given
  // back here) or, worse, let a new CutSheet reference a remnant this
  // cleanup is about to delete, violating the FK.
  await clearStaleCutSheets(estimateVersionId, materialId);

  if (parts.length === 0) {
    return [];
  }

  const allInstances: Instance[] = [];
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
      allInstances.push({ cutListPartId: part.id, width, height, preRotated, grainConstrained: part.grainConstrained });
    }
  }

  // Remnants first, smallest usable piece before a bigger one -- real
  // shop heuristic (use up small scraps, save bigger reusable pieces for
  // bigger future needs), and the actual point of this feature: using
  // already-owned material is free, a fresh sheet costs real money.
  const availableRemnants = await db.materialRemnant.findMany({
    where: { materialId, consumedAt: null },
    orderBy: [{ width: "asc" }, { length: "asc" }],
  });

  const bins: BinResult[] = [];
  let remaining = allInstances;

  for (const remnant of availableRemnants) {
    if (remaining.length === 0) break;
    const rw = remnant.width.toNumber();
    const rl = remnant.length.toNumber();
    const { result, unplaced } = packOneBin(remaining, rw, rl, kerf, minRemnantDimension);
    if (result.placed.length > 0) {
      bins.push({ ...result, consumedRemnantId: remnant.id });
    }
    remaining = result.placed.length > 0 ? unplaced : remaining;
  }

  // padding (the packer's 3rd constructor arg) is spacing applied
  // between every placed rect -- kerf is exactly that, the material
  // actually lost to each cut, so this is the real mechanism, not a
  // manual per-rect inflate-then-shrink-back workaround. Unlike the
  // remnant loop above, the packer's own multi-bin behavior is exactly
  // right here: an unlimited supply of fresh same-size sheets is a
  // correct assumption.
  if (remaining.length > 0) {
    const packer = new MaxRectsPacker(stockWidth, stockLength, kerf, { smart: false, pot: false, square: false });
    for (const inst of remaining) {
      const rect = new Rectangle(inst.width, inst.height, 0, 0, false, !inst.grainConstrained);
      rect.data = inst;
      packer.add(rect);
    }
    for (const bin of packer.bins) {
      bins.push({
        placed: bin.rects.map((r) => ({
          cutListPartId: (r.data as { cutListPartId: string }).cutListPartId,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          rotated: (r.data as { preRotated: boolean }).preRotated !== r.rot,
        })),
        consumedRemnantId: null,
        generatedRemnant: extractLargestRemnantCandidate(bin.freeRects, minRemnantDimension),
      });
    }
  }

  await db.$transaction(async (tx) => {
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      const sheet = await tx.cutSheet.create({
        data: {
          estimateVersionId,
          materialId,
          sheetNumber: i + 1,
          layout: bin.placed as unknown as Prisma.InputJsonValue,
          consumedRemnantId: bin.consumedRemnantId,
        },
      });
      if (bin.consumedRemnantId) {
        await tx.materialRemnant.update({ where: { id: bin.consumedRemnantId }, data: { consumedAt: new Date() } });
      }
      if (bin.generatedRemnant) {
        await tx.materialRemnant.create({
          data: {
            materialId,
            width: bin.generatedRemnant.width,
            length: bin.generatedRemnant.length,
            generatedByCutSheetId: sheet.id,
          },
        });
      }
    }
  });

  return bins.map((b) => b.placed);
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

// Phase 3: joins a material's stored CutSheet layouts (position/size
// only -- see PlacedPart) with its CutListParts (to get each placed
// instance's real description) into the shape cut-sheet-pdf.tsx renders
// from. A read, not a compute -- run optimizeNestingForMaterial first;
// this throws if that's never been done, same "click Propose/Optimize
// first" posture as commitScopeLineItems's identical guard.
export interface CutSheetDiagramData {
  materialName: string;
  stockWidth: number;
  stockLength: number;
  sheets: {
    sheetNumber: number;
    isRemnant: boolean;
    // The REAL usable area for THIS sheet -- the material's nominal
    // stockWidth/stockLength above for an ordinary fresh sheet, or the
    // specific consumed remnant's own (smaller) dimensions. A renderer
    // must draw against this, not the material's nominal size, or a
    // shop-floor cut is made against the wrong assumed sheet.
    width: number;
    length: number;
    parts: (PlacedPart & { description: string })[];
  }[];
}

export async function getCutSheetDiagramData(
  estimateVersionId: string,
  materialId: string,
): Promise<CutSheetDiagramData> {
  const material = await db.material.findUniqueOrThrow({ where: { id: materialId } });
  const sheets = await db.cutSheet.findMany({
    where: { estimateVersionId, materialId },
    orderBy: { sheetNumber: "asc" },
    include: { consumedRemnant: true },
  });
  if (sheets.length === 0) {
    throw new Error(`No cutting diagram for "${material.name}" yet -- run Optimize first.`);
  }

  const parts = await db.cutListPart.findMany({ where: { estimateVersionId, materialId } });
  const descriptionById = new Map(parts.map((p) => [p.id, p.description]));

  return {
    materialName: material.name,
    stockWidth: material.stockWidth!.toNumber(),
    stockLength: material.stockLength!.toNumber(),
    sheets: sheets.map((sheet) => ({
      sheetNumber: sheet.sheetNumber,
      isRemnant: sheet.consumedRemnant != null,
      width: sheet.consumedRemnant ? sheet.consumedRemnant.width.toNumber() : material.stockWidth!.toNumber(),
      length: sheet.consumedRemnant ? sheet.consumedRemnant.length.toNumber() : material.stockLength!.toNumber(),
      parts: (sheet.layout as unknown as PlacedPart[]).map((p) => ({
        ...p,
        description: descriptionById.get(p.cutListPartId) ?? "Unknown part",
      })),
    })),
  };
}

// Phase 4: the REAL waste/cost figure, computed directly from actual
// packed layouts (Phase 2) rather than a rough pre-nesting estimate --
// the plan's own original phase 4 framed this as "replace phase 1's
// naive waste estimate," but phase 1 (a parts-list UI with its own rough
// area-vs-stock guess) was never built, so there's no naive figure to
// replace -- this is just the real report, buildable now because
// optimizeNestingForMaterial already produces exact placements to sum.
export interface MaterialWasteReport {
  materialId: string;
  materialName: string;
  sheetsUsed: number;
  // Phase 5: a remnant-based sheet is already-owned material -- $0, not
  // a display quirk. Only fresh sheets cost real money; this is the
  // actual point of remnant reuse made visible, not just a nicer sheet
  // count. freshSheetsUsed + remnantSheetsUsed === sheetsUsed always.
  freshSheetsUsed: number;
  remnantSheetsUsed: number;
  // freshSheetsUsed * currentUnitCost -- material cost only, no labor/
  // kerf-loss-as-a-dollar-figure; kerf is already reflected physically
  // in sheetsUsed (more kerf spacing can push a layout onto an extra
  // sheet).
  totalCost: number;
  usedAreaSqIn: number;
  // Sum of each sheet's OWN real area -- a remnant sheet's actual
  // (smaller) area, not the material's full nominal stock area, so
  // waste% isn't computed against a denominator larger than the real
  // stock that sheet was ever cut from.
  totalStockAreaSqIn: number;
  // 0-1, not a percentage string -- same "store the number, format at
  // the UI layer" posture as every other computed figure in this app
  // (e.g. EstimateVersion.grossMarginPct's own callers).
  wastePct: number;
}

export async function getMaterialWasteReport(
  estimateVersionId: string,
  materialId: string,
): Promise<MaterialWasteReport> {
  const material = await db.material.findUniqueOrThrow({ where: { id: materialId } });
  const sheets = await db.cutSheet.findMany({
    where: { estimateVersionId, materialId },
    include: { consumedRemnant: true },
  });
  if (sheets.length === 0) {
    throw new Error(`No cutting layout for "${material.name}" yet -- run Optimize first.`);
  }

  const stockWidth = material.stockWidth!.toNumber();
  const stockLength = material.stockLength!.toNumber();
  const unitCost = material.currentUnitCost.toNumber();

  const freshSheetsUsed = sheets.filter((s) => !s.consumedRemnant).length;
  const remnantSheetsUsed = sheets.length - freshSheetsUsed;

  const usedAreaSqIn = sheets.reduce((sum, sheet) => {
    const layout = sheet.layout as unknown as PlacedPart[];
    return sum + layout.reduce((s, part) => s + part.width * part.height, 0);
  }, 0);
  const totalStockAreaSqIn = sheets.reduce((sum, sheet) => {
    if (sheet.consumedRemnant) return sum + sheet.consumedRemnant.width.toNumber() * sheet.consumedRemnant.length.toNumber();
    return sum + stockWidth * stockLength;
  }, 0);

  return {
    materialId,
    materialName: material.name,
    sheetsUsed: sheets.length,
    freshSheetsUsed,
    remnantSheetsUsed,
    totalCost: freshSheetsUsed * unitCost,
    usedAreaSqIn,
    totalStockAreaSqIn,
    wastePct: totalStockAreaSqIn === 0 ? 0 : 1 - usedAreaSqIn / totalStockAreaSqIn,
  };
}

export interface CutListCostReport {
  materials: MaterialWasteReport[];
  totalCost: number;
  totalSheetsUsed: number;
}

// Version-level rollup across every material that's actually been
// optimized -- same "find every distinct material with real CutSheet
// rows" shape optimizeNestingForVersion already established, reused here
// for reporting instead of computing.
export async function getCutListCostReport(estimateVersionId: string): Promise<CutListCostReport> {
  const materialIds = await db.cutSheet.findMany({
    where: { estimateVersionId },
    select: { materialId: true },
    distinct: ["materialId"],
  });

  const materials = await Promise.all(
    materialIds.map(({ materialId }) => getMaterialWasteReport(estimateVersionId, materialId)),
  );

  return {
    materials,
    totalCost: materials.reduce((sum, m) => sum + m.totalCost, 0),
    totalSheetsUsed: materials.reduce((sum, m) => sum + m.sheetsUsed, 0),
  };
}
