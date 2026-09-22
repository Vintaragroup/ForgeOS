// Where a piece is produced. See ArtworkOrder.routings for why this is a
// set rather than a single vendorId.
//
// The rule worth stating: EXPO_IN_HOUSE is only valid at an office that
// actually has a sign shop. Miami is the only one today. That check is the
// reason Office.hasSignShop exists -- without it, "rigid printing defaults
// to Expo" (the Miami SOP's rule) would have been applied company-wide and
// silently mis-set the default on 98% of Orlando's rigid work.

import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { ArtworkProductionStatus, ArtworkRoutingKind } from "@/generated/prisma/enums";
import {
  defaultProductionStatus,
  PRODUCTION_STATUS_LABELS,
  PRODUCTION_STATUSES_BY_KIND,
} from "@/lib/artwork-routing-vocab";

export {
  PRODUCTION_STATUSES_BY_KIND,
  PRODUCTION_STATUS_LABELS,
  defaultProductionStatus,
  isHalfSettled,
  isFullyProduced,
} from "@/lib/artwork-routing-vocab";

export interface RoutingInput {
  kind: ArtworkRoutingKind;
  // Required for VENDOR, ignored otherwise.
  vendorId?: string | null;
  // Required for EXPO_IN_HOUSE, ignored otherwise.
  officeCode?: string | null;
  note?: string | null;
  productionStatus?: ArtworkProductionStatus | null;
}

// A stable key for de-duplicating a set. Two VENDOR entries for the same
// shop are one entry; two EXPO_IN_HOUSE entries at the same office
// likewise. There is no DB unique index doing this -- nullable columns
// make NULLs distinct in Postgres, so an index would not catch it.
function routingKey(entry: RoutingInput): string {
  switch (entry.kind) {
    case "VENDOR":
      return `VENDOR:${entry.vendorId ?? ""}`;
    case "EXPO_IN_HOUSE":
      return `EXPO_IN_HOUSE:${entry.officeCode ?? ""}`;
    default:
      return "AM_PM_COORDINATED";
  }
}

async function validate(entries: RoutingInput[]): Promise<RoutingInput[]> {
  if (entries.length === 0) return [];

  const vendorIds = [...new Set(entries.filter((e) => e.kind === "VENDOR").map((e) => e.vendorId).filter(Boolean))] as string[];
  const officeCodes = [...new Set(entries.filter((e) => e.kind === "EXPO_IN_HOUSE").map((e) => e.officeCode).filter(Boolean))] as string[];

  const [vendors, offices] = await Promise.all([
    vendorIds.length ? db.vendor.findMany({ where: { id: { in: vendorIds }, deletedAt: null }, select: { id: true } }) : [],
    officeCodes.length
      ? db.office.findMany({ where: { code: { in: officeCodes }, deletedAt: null }, select: { code: true, name: true, hasSignShop: true } })
      : [],
  ]);
  const liveVendors = new Set(vendors.map((v) => v.id));
  const officeByCode = new Map(offices.map((o) => [o.code, o]));

  const seen = new Set<string>();
  const cleaned: RoutingInput[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "VENDOR": {
        if (!entry.vendorId) throw new UserError("Pick which print shop this is going to.");
        if (!liveVendors.has(entry.vendorId)) throw new UserError("That print shop no longer exists.");
        break;
      }
      case "EXPO_IN_HOUSE": {
        if (!entry.officeCode) throw new UserError("Say which Expo sign shop is producing this.");
        const office = officeByCode.get(entry.officeCode);
        if (!office) throw new UserError("That office doesn't exist.");
        if (!office.hasSignShop) {
          throw new UserError(
            `${office.name} has no sign shop, so it can't produce this in-house. Send it to a print shop, or let the AM/PM coordinate it.`,
          );
        }
        break;
      }
      case "AM_PM_COORDINATED":
        break;
    }
    if (entry.productionStatus && !PRODUCTION_STATUSES_BY_KIND[entry.kind].includes(entry.productionStatus)) {
      throw new UserError(
        `"${PRODUCTION_STATUS_LABELS[entry.productionStatus]}" isn't a status ${
          entry.kind === "EXPO_IN_HOUSE" ? "in-house work" : entry.kind === "VENDOR" ? "an outside shop" : "AM/PM-coordinated work"
        } can be in.`,
      );
    }
    const key = routingKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(entry);
  }
  return cleaned;
}

// Replaces the whole set. Routing is edited as a set ("Expo AND Binick"),
// not accumulated one entry at a time, so a replace is the honest
// operation -- and it means removing a half is possible.
export async function setArtworkRouting(artworkOrderId: string, entries: RoutingInput[]) {
  const order = await db.artworkOrder.findFirst({ where: { id: artworkOrderId, deletedAt: null }, select: { id: true } });
  if (!order) throw new UserError("That piece no longer exists.");

  const cleaned = await validate(entries);

  // This replaces the set by deleting and recreating, so a half that is
  // already "O.S Received" would come back "O.S not sent" every time
  // someone re-saved the editor. Carry each surviving half's status over
  // by its key; only a genuinely new half starts at its default.
  const existing = await db.artworkOrderRouting.findMany({
    where: { artworkOrderId },
    select: { kind: true, vendorId: true, officeCode: true, productionStatus: true },
  });
  const statusByKey = new Map(existing.map((r) => [routingKey(r), r.productionStatus]));

  await db.$transaction(async (tx) => {
    await tx.artworkOrderRouting.deleteMany({ where: { artworkOrderId } });
    for (const entry of cleaned) {
      const carried = statusByKey.get(routingKey(entry));
      const status = entry.productionStatus ?? carried ?? defaultProductionStatus(entry.kind);
      await tx.artworkOrderRouting.create({
        data: {
          artworkOrderId,
          kind: entry.kind,
          vendorId: entry.kind === "VENDOR" ? entry.vendorId! : null,
          officeCode: entry.kind === "EXPO_IN_HOUSE" ? entry.officeCode! : null,
          productionStatus: PRODUCTION_STATUSES_BY_KIND[entry.kind].includes(status)
            ? status
            : defaultProductionStatus(entry.kind),
          note: entry.note?.trim() || null,
        },
      });
    }
    // Keep the legacy column in step: it still drives the vendor portal
    // invite and the detail page's picker. A split piece reports its first
    // outside shop, which is the one a vendor invite would go to.
    const firstVendor = cleaned.find((e) => e.kind === "VENDOR")?.vendorId ?? null;
    await tx.artworkOrder.update({ where: { id: artworkOrderId }, data: { vendorId: firstVendor } });
  });

  return loadArtworkRouting(artworkOrderId);
}

// "This piece's outside shop is X." Replaces any VENDOR entries but keeps
// the rest, so assigning a vendor to a piece that is ALSO being produced
// in-house doesn't silently delete the in-house half -- which is a real
// shape here: 50 of 282 Seatrade rows are split that way.
export async function assignSingleVendor(artworkOrderId: string, vendorId: string) {
  const existing = await loadArtworkRouting(artworkOrderId);
  const kept: RoutingInput[] = existing
    .filter((r) => r.kind !== "VENDOR")
    .map((r) => ({ kind: r.kind, officeCode: r.officeCode, note: r.note }));
  return setArtworkRouting(artworkOrderId, [...kept, { kind: "VENDOR", vendorId }]);
}

// Moves ONE half. The whole point of per-half status is that the vendor
// coming back doesn't touch what the sign shop is doing.
export async function setHalfProductionStatus(routingId: string, status: ArtworkProductionStatus) {
  const routing = await db.artworkOrderRouting.findUnique({ where: { id: routingId }, select: { id: true, kind: true } });
  if (!routing) throw new UserError("That production half no longer exists.");
  if (!PRODUCTION_STATUSES_BY_KIND[routing.kind].includes(status)) {
    throw new UserError(`"${PRODUCTION_STATUS_LABELS[status]}" isn't a status this half can be in.`);
  }
  await db.artworkOrderRouting.update({ where: { id: routingId }, data: { productionStatus: status } });
}

export async function loadArtworkRouting(artworkOrderId: string) {
  return db.artworkOrderRouting.findMany({
    where: { artworkOrderId },
    include: { vendor: { select: { id: true, name: true, initials: true } }, office: { select: { code: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export type ArtworkRouting = Awaited<ReturnType<typeof loadArtworkRouting>>[number];

// One line for a dense table: "Expo (Miami) + Binick Imaginig - Miami".
export function describeRouting(routings: ArtworkRouting[]): string {
  if (routings.length === 0) return "Not routed yet";
  return routings
    .map((r) => {
      switch (r.kind) {
        case "EXPO_IN_HOUSE":
          return `Expo${r.office ? ` (${r.office.name})` : ""}`;
        case "VENDOR":
          return r.vendor?.name ?? "Unknown shop";
        default:
          return "AM/PM coordinating";
      }
    })
    .join(" + ");
}

// Which offices may be picked for in-house production. Empty everywhere
// except Miami today, which is the point: the UI should not offer an
// option the service will reject.
export async function signShopOffices() {
  return db.office.findMany({
    where: { deletedAt: null, hasSignShop: true },
    select: { code: true, name: true },
    orderBy: { name: "asc" },
  });
}
