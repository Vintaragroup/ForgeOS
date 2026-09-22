import { describe, expect, it } from "vitest";
import { buildShipping, type ShippingPiece, type ShippingSkid } from "@/lib/graphics-shipping";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function days(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}

interface Piece extends ShippingPiece {
  id: string;
}

function piece(id: string, overrides: Partial<ShippingPiece> = {}): Piece {
  return { id, status: "PACKAGED_READY", skidId: null, material: null, graphicCode: null, showStartDate: null, ...overrides };
}

function skid(id: string, overrides: Partial<ShippingSkid> = {}): ShippingSkid {
  return { id, code: id.toUpperCase(), labelColor: null, sentAt: null, showId: "s1", showName: "Seatrade", ...overrides };
}

function ship(pieces: Piece[], skids: ShippingSkid[] = []) {
  return buildShipping(pieces, (p) => p, skids);
}

describe("ready to pack", () => {
  it("is a packaged piece with no crate yet", () => {
    const result = ship([piece("ready", { status: "PACKAGED_READY" })]);
    expect(result.readyToPack.map((p) => p.id)).toEqual(["ready"]);
  });

  it("is not a piece still being made", () => {
    const result = ship([
      piece("producing", { status: "IN_PRODUCTION" }),
      piece("inspected", { status: "INSPECTED" }),
      piece("invited", { status: "INVITED" }),
    ]);
    expect(result.readyToPack).toHaveLength(0);
  });

  it("is not a piece that has already gone", () => {
    const result = ship([
      piece("shipped", { status: "SHIPPED_TO_SHOW" }),
      piece("delivered", { status: "DELIVERED_AT_SHOW" }),
    ]);
    expect(result.readyToPack).toHaveLength(0);
  });

  it("puts the soonest show first, undated last", () => {
    const result = ship([
      piece("undated"),
      piece("far", { showStartDate: days(90) }),
      piece("near", { showStartDate: days(5) }),
    ]);
    expect(result.readyToPack.map((p) => p.id)).toEqual(["near", "far", "undated"]);
  });
});

describe("skids", () => {
  it("loads each crate with its own pieces", () => {
    const a = skid("a");
    const b = skid("b");
    const result = ship(
      [piece("p1", { skidId: "a" }), piece("p2", { skidId: "a" }), piece("p3", { skidId: "b" })],
      [a, b],
    );
    expect(result.openSkids.find((s) => s.skid.id === "a")?.contents).toHaveLength(2);
    expect(result.openSkids.find((s) => s.skid.id === "b")?.contents).toHaveLength(1);
    expect(result.onOpenSkidsCount).toBe(3);
  });

  it("loads heaviest first, per the SOP", () => {
    // "PVC panels are packed first due to weight followed by lighter
    // material such as foamboard and vinyl."
    const result = ship(
      [
        piece("fabric", { skidId: "a", material: "Fabric (Black-Back)" }),
        piece("pvc", { skidId: "a", material: 'PVC (White) - 1/8"' }),
        piece("vinyl", { skidId: "a", material: "Vinyl (White)" }),
        piece("foam", { skidId: "a", material: 'Foamboard - 3/16"' }),
      ],
      [skid("a")],
    );
    expect(result.openSkids[0].contents.map((p) => p.id)).toEqual(["pvc", "foam", "vinyl", "fabric"]);
  });

  it("puts a piece with an unknown material at the end, not the bottom of the crate", () => {
    // Guessing something is heavy enough to sit under everything else is
    // the costly direction to be wrong in.
    const result = ship(
      [piece("mystery", { skidId: "a", material: null }), piece("pvc", { skidId: "a", material: "PVC (Black) - 6mm" })],
      [skid("a")],
    );
    expect(result.openSkids[0].contents.map((p) => p.id)).toEqual(["pvc", "mystery"]);
  });

  it("keeps crates on the dock apart from crates that have gone", () => {
    const result = ship(
      [piece("p1", { skidId: "open" }), piece("p2", { skidId: "gone", status: "SHIPPED_TO_SHOW" })],
      [skid("open"), skid("gone", { sentAt: days(-1) })],
    );
    expect(result.openSkids.map((s) => s.skid.id)).toEqual(["open"]);
    expect(result.sentSkids.map((s) => s.skid.id)).toEqual(["gone"]);
    // A shipped crate's contents are not waiting to be packed.
    expect(result.readyToPack).toHaveLength(0);
  });

  it("puts the fullest crate on the dock first, and the most recent departure first", () => {
    const result = ship(
      [
        piece("p1", { skidId: "small" }),
        piece("p2", { skidId: "big" }),
        piece("p3", { skidId: "big" }),
        piece("p4", { skidId: "old", status: "SHIPPED_TO_SHOW" }),
        piece("p5", { skidId: "recent", status: "SHIPPED_TO_SHOW" }),
      ],
      [
        skid("small"),
        skid("big"),
        skid("old", { sentAt: days(-10) }),
        skid("recent", { sentAt: days(-1) }),
      ],
    );
    expect(result.openSkids.map((s) => s.skid.id)).toEqual(["big", "small"]);
    expect(result.sentSkids.map((s) => s.skid.id)).toEqual(["recent", "old"]);
  });

  it("shows an empty crate rather than hiding it -- you still have to load it", () => {
    const result = ship([], [skid("empty")]);
    expect(result.openSkids).toHaveLength(1);
    expect(result.openSkids[0].contents).toEqual([]);
  });
});

describe("drift between a crate and its contents", () => {
  it("flags a piece whose crate has gone but whose own status never moved", () => {
    // markSkidSent updates the skid, not its contents. A piece that is
    // physically at the show while the system still calls it "packaged"
    // is how a reprint gets ordered for something already on the floor.
    const result = ship(
      [
        piece("stale", { skidId: "gone", status: "PACKAGED_READY" }),
        piece("correct", { skidId: "gone", status: "SHIPPED_TO_SHOW" }),
      ],
      [skid("gone", { sentAt: days(-2) })],
    );
    expect(result.shippedButNotMarked.map((p) => p.id)).toEqual(["stale"]);
  });

  it("does not flag anything on a crate still sitting on the dock", () => {
    const result = ship([piece("waiting", { skidId: "open", status: "PACKAGED_READY" })], [skid("open")]);
    expect(result.shippedButNotMarked).toHaveLength(0);
  });

  it("accepts delivered as having shipped", () => {
    const result = ship(
      [piece("arrived", { skidId: "gone", status: "DELIVERED_AT_SHOW" })],
      [skid("gone", { sentAt: days(-2) })],
    );
    expect(result.shippedButNotMarked).toHaveLength(0);
  });
});

describe("a piece pointing at a crate that isn't listed", () => {
  it("does not silently count it as ready to pack", () => {
    // Skids are listed per show; a piece from a show outside this view
    // must not reappear in the pack queue as though it had no crate.
    const result = ship([piece("elsewhere", { skidId: "another-shows-skid", status: "PACKAGED_READY" })], []);
    expect(result.readyToPack).toHaveLength(0);
    expect(result.onOpenSkidsCount).toBe(0);
  });
});
