// The last hop: finished pieces onto crates, crates onto trucks.
//
// All of this already existed in skid-service -- packing a piece, marking
// a skid sent, and the SOP's loading order ("PVC panels are packed first
// due to weight followed by lighter material such as foamboard and
// vinyl"). What it did not have was anywhere to be seen. skidContents and
// sortForPacking had no callers at all, so the packing rule was written
// down and never once rendered, and the only way to see a skid was to
// already know which show it belonged to.
//
// This groups by SKID rather than by piece, for the same reason the shop
// floor groups by half: a skid is the thing a person acts on. You load
// one, you send one.
//
// A leaf module: pure functions over plain data, no db import.

import type { ArtworkOrderStatus } from "@/generated/prisma/enums";
import { sortForPacking } from "@/lib/skid-packing";

// A piece is ready for a crate once it physically exists and packaging is
// done. Earlier than this there is nothing to load.
const READY_TO_PACK: ReadonlySet<ArtworkOrderStatus> = new Set(["PACKAGED_READY"]);

// Statuses that agree the piece has left the building.
const HAS_SHIPPED: ReadonlySet<ArtworkOrderStatus> = new Set(["SHIPPED_TO_SHOW", "DELIVERED_AT_SHOW"]);

export interface ShippingPiece {
  status: ArtworkOrderStatus;
  skidId: string | null;
  material: string | null;
  graphicCode: string | null;
  showStartDate: Date | null;
}

export interface ShippingSkid {
  id: string;
  code: string;
  labelColor: string | null;
  sentAt: Date | null;
  showId: string;
  showName: string;
}

export interface LoadedSkid<T> {
  skid: ShippingSkid;
  // In the order someone should physically load it: heaviest first.
  contents: T[];
}

export interface Shipping<T> {
  // Packaged, not on a crate yet. Soonest show first.
  readyToPack: T[];
  // Crates still on the dock, fullest first.
  openSkids: LoadedSkid<T>[];
  // Crates that have left, most recent departure first.
  sentSkids: LoadedSkid<T>[];
  // On a crate that has already gone, but the piece's own status never
  // moved. markSkidSent updates the skid, not its contents, so this drift
  // is structurally possible -- and a piece that is physically at the show
  // while the system still calls it "packaged" is how a reprint gets
  // ordered for something already sitting on the floor.
  shippedButNotMarked: T[];
  readyToPackCount: number;
  onOpenSkidsCount: number;
}

function byDateAscNullsLast(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

export function buildShipping<T>(
  orders: T[],
  read: (order: T) => ShippingPiece,
  skids: ShippingSkid[],
): Shipping<T> {
  const bySkid = new Map<string, T[]>();
  const readyToPack: T[] = [];
  const shippedButNotMarked: T[] = [];
  const knownSkidIds = new Set(skids.map((s) => s.id));

  for (const order of orders) {
    const piece = read(order);

    // Being on a crate at all disqualifies a piece from the pack queue,
    // even a crate this view isn't listing. Skids are listed per show, so
    // falling through on an unknown id would put pieces from a show
    // outside the view back into "ready to pack" as though they were
    // loose -- and send someone looking for a crate they'd already packed.
    if (piece.skidId) {
      if (knownSkidIds.has(piece.skidId)) {
        const list = bySkid.get(piece.skidId) ?? [];
        list.push(order);
        bySkid.set(piece.skidId, list);
      }
      continue;
    }
    // Loose. Only packaged pieces are waiting for a crate; anything
    // earlier is still being made, and anything later has gone.
    if (READY_TO_PACK.has(piece.status)) readyToPack.push(order);
  }

  readyToPack.sort((a, b) => byDateAscNullsLast(read(a).showStartDate, read(b).showStartDate));

  // sortForPacking reads material and graphicCode, which is exactly what
  // ShippingPiece carries -- the row is widened through `read` so the
  // caller's own type never has to match the sorter's, then unwrapped.
  const loaded = (skid: ShippingSkid): LoadedSkid<T> => ({
    skid,
    contents: sortForPacking((bySkid.get(skid.id) ?? []).map((order) => ({ order, ...read(order) }))).map((row) => row.order),
  });

  const openSkids = skids.filter((s) => !s.sentAt).map(loaded);
  const sentSkids = skids.filter((s) => s.sentAt).map(loaded);

  for (const { skid, contents } of sentSkids) {
    if (!skid.sentAt) continue;
    for (const order of contents) {
      if (!HAS_SHIPPED.has(read(order).status)) shippedButNotMarked.push(order);
    }
  }

  openSkids.sort((a, b) => b.contents.length - a.contents.length || a.skid.code.localeCompare(b.skid.code));
  sentSkids.sort((a, b) => (b.skid.sentAt?.getTime() ?? 0) - (a.skid.sentAt?.getTime() ?? 0));

  return {
    readyToPack,
    openSkids,
    sentSkids,
    shippedButNotMarked,
    readyToPackCount: readyToPack.length,
    onOpenSkidsCount: openSkids.reduce((n, s) => n + s.contents.length, 0),
  };
}
