// Packing: which crate a finished piece went on, and when it shipped.
// SOP Step 8.
//
// Her tracker records this in the Packed column, whose choices are
// Completed, Cancelled and "Item A" through "Item H" -- a status field
// carrying crate identifiers. Splitting them means a skid can hold the
// things a skid actually has: a colour, a ship time, and contents.

import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { describeSection, overlappingSection } from "@/lib/show-section";

export { packingRank, sortForPacking } from "@/lib/skid-packing";

import { sortForPacking } from "@/lib/skid-packing";

export async function createSkid(showId: string, input: { code: string; labelColor?: string | null; note?: string | null }) {
  const code = input.code.trim();
  if (!code) throw new UserError("Give the skid the code written on its label.");

  const show = await db.show.findFirst({ where: { id: showId, deletedAt: null }, select: { id: true } });
  if (!show) throw new UserError("That show no longer exists.");

  // Codes restart per show, so a clash is only a clash within one.
  const clash = await db.skid.findFirst({ where: { showId, code, deletedAt: null }, select: { id: true } });
  if (clash) throw new UserError(`This show already has a skid called ${code}.`);

  return db.skid.create({ data: { showId, code, labelColor: input.labelColor?.trim() || null, note: input.note?.trim() || null } });
}

export async function listSkids(showId: string) {
  return db.skid.findMany({
    where: { showId, deletedAt: null },
    orderBy: [{ sentAt: "asc" }, { code: "asc" }],
    include: { _count: { select: { artworkOrders: true } } },
  });
}

// Which show a piece belongs to, whether it hangs off an opportunity or
// the show directly -- the same two paths the Graphics Hub reads.
async function showIdForOrder(artworkOrderId: string): Promise<string | null> {
  const order = await db.artworkOrder.findFirst({
    where: { id: artworkOrderId, deletedAt: null },
    select: { showId: true, opportunity: { select: { showId: true } } },
  });
  if (!order) throw new UserError("That piece no longer exists.");
  return order.showId ?? order.opportunity?.showId ?? null;
}

export async function packOntoSkid(artworkOrderId: string, skidId: string | null) {
  if (skidId === null) {
    await db.artworkOrder.update({ where: { id: artworkOrderId }, data: { skidId: null, packedAt: null } });
    return;
  }

  const [orderShowId, skid] = await Promise.all([
    showIdForOrder(artworkOrderId),
    db.skid.findFirst({ where: { id: skidId, deletedAt: null }, select: { id: true, showId: true, code: true, sentAt: true } }),
  ]);
  if (!skid) throw new UserError("That skid no longer exists.");

  // A piece from one show on another show's skid is how graphics arrive at
  // the wrong venue.
  if (orderShowId && skid.showId !== orderShowId) {
    throw new UserError("That skid belongs to a different show.");
  }
  if (skid.sentAt) {
    throw new UserError(`${skid.code} has already shipped -- pack this onto a skid that hasn't left yet.`);
  }

  await db.artworkOrder.update({ where: { id: artworkOrderId }, data: { skidId, packedAt: new Date() } });
}

// The skid physically leaves. Recorded to the minute because the SOP asks
// for the time as well as the date.
export async function markSkidSent(skidId: string, sentAt: Date = new Date()) {
  const skid = await db.skid.findFirst({
    where: { id: skidId, deletedAt: null },
    select: { id: true, code: true, sentAt: true, _count: { select: { artworkOrders: true } } },
  });
  if (!skid) throw new UserError("That skid no longer exists.");
  if (skid.sentAt) throw new UserError(`${skid.code} was already marked as sent.`);
  if (skid._count.artworkOrders === 0) {
    throw new UserError(`${skid.code} has nothing packed on it yet.`);
  }
  return db.skid.update({ where: { id: skidId }, data: { sentAt } });
}

// What is on a skid, in the order it should be loaded.
export async function skidContents(skidId: string) {
  const pieces = await db.artworkOrder.findMany({
    where: { skidId, deletedAt: null },
    select: {
      id: true,
      jobCode: true,
      graphicCode: true,
      material: true,
      qty: true,
      opportunity: { select: { company: { select: { name: true } } } },
    },
  });
  return sortForPacking(pieces);
}

// --- show sections -----------------------------------------------------
// Sections live here rather than in their own service because they are the
// other half of the same job: skids are how finished work is grouped to
// ship, sections are how it is grouped on the floor.

export async function listShowSections(showId: string) {
  return db.showSection.findMany({
    where: { showId, deletedAt: null },
    orderBy: { boothStart: "asc" },
    include: { lead: { select: { id: true, name: true } } },
  });
}

export async function createShowSection(
  showId: string,
  input: { name: string; boothStart: number; boothEnd: number; leadUserId?: string | null },
) {
  const name = input.name.trim();
  if (!name) throw new UserError("Name the section.");
  if (!Number.isSafeInteger(input.boothStart) || !Number.isSafeInteger(input.boothEnd)) {
    throw new UserError("Booth numbers must be whole numbers.");
  }
  if (input.boothEnd < input.boothStart) throw new UserError("The last booth can't come before the first one.");

  const show = await db.show.findFirst({ where: { id: showId, deletedAt: null }, select: { id: true } });
  if (!show) throw new UserError("That show no longer exists.");

  const existing = await listShowSections(showId);
  if (existing.some((s) => s.name === name)) throw new UserError(`This show already has a ${name}.`);

  // A booth in two sections has no answer, so overlaps are refused rather
  // than resolved by whichever row happens to be found first.
  const clash = overlappingSection(existing, { boothStart: input.boothStart, boothEnd: input.boothEnd });
  if (clash) {
    throw new UserError(`Booths ${input.boothStart}-${input.boothEnd} overlap ${describeSection(clash)}.`);
  }

  return db.showSection.create({
    data: { showId, name, boothStart: input.boothStart, boothEnd: input.boothEnd, leadUserId: input.leadUserId || null },
  });
}

export async function deleteShowSection(sectionId: string) {
  // Soft delete, and nothing to cascade: no piece points at a section,
  // because a section is derived from the booth number.
  await db.showSection.updateMany({ where: { id: sectionId, deletedAt: null }, data: { deletedAt: new Date() } });
}
