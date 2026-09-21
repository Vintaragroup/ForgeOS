import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSkid, listSkids, markSkidSent, packOntoSkid, packingRank, skidContents, sortForPacking } from "@/lib/skid-service";
import { UserError } from "@/lib/user-error";

afterEach(async () => {
  await db.artworkOrder.deleteMany();
  await db.skid.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.show.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

let n = 0;
async function show(name = "Seatrade") {
  n += 1;
  return db.show.create({ data: { name: `${name} ${n}`, eventStartDate: new Date("2027-04-07T00:00:00Z") } });
}
async function piece(showId: string, material: string | null, code: string) {
  n += 1;
  return db.artworkOrder.create({ data: { showId, jobCode: `SKID-${n}`, material, graphicCode: code } });
}

describe("packing order", () => {
  it("follows the SOP: PVC first by weight, then lighter material", () => {
    // "PVC panels are packed first due to weight followed by lighter
    // material such as foamboard and vinyl."
    expect(packingRank('PVC (White) - 1/8"')).toBeLessThan(packingRank("Foamboard - 3/16\""));
    expect(packingRank("Foamboard - 3/16\"")).toBeLessThan(packingRank("Vinyl (White)"));
    expect(packingRank("Vinyl (White)")).toBeLessThan(packingRank("Fabric (Black-Back)"));
  });

  it("puts an unknown material last rather than at the bottom of the crate", () => {
    // Guessing something is heavy enough to take the weight of a stack is
    // the costly direction to be wrong in.
    expect(packingRank("Something new")).toBeGreaterThan(packingRank("Fabric (Black-Back)"));
    expect(packingRank(null)).toBeGreaterThan(packingRank('PVC (White) - 1/8"'));
  });

  it("sorts a mixed crate into load order", () => {
    const sorted = sortForPacking([
      { material: "Vinyl (White)", graphicCode: "C" },
      { material: 'PVC (White) - 1/8"', graphicCode: "A" },
      { material: "Fabric (Black-Back)", graphicCode: "D" },
      { material: "Foamboard - 3/16\"", graphicCode: "B" },
    ]);
    expect(sorted.map((p) => p.graphicCode)).toEqual(["A", "B", "C", "D"]);
  });

  it("is stable for two pieces of the same material", () => {
    const sorted = sortForPacking([
      { material: 'PVC (White) - 1/8"', graphicCode: "B2" },
      { material: 'PVC (White) - 1/8"', graphicCode: "A1" },
    ]);
    expect(sorted.map((p) => p.graphicCode)).toEqual(["A1", "B2"]);
  });
});

describe("createSkid", () => {
  it("takes the code written on the physical label", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A", labelColor: "orange" });
    expect(skid).toMatchObject({ code: "Item A", labelColor: "orange", sentAt: null });
  });

  it("rejects a duplicate code within one show", async () => {
    const s = await show();
    await createSkid(s.id, { code: "Item A" });
    await expect(createSkid(s.id, { code: "Item A" })).rejects.toThrow(/already has a skid called Item A/);
  });

  it("lets two different shows each have an Item A, since the codes restart", async () => {
    const [a, b] = [await show("Seatrade"), await show("PGA")];
    await expect(createSkid(a.id, { code: "Item A" })).resolves.toBeDefined();
    await expect(createSkid(b.id, { code: "Item A" })).resolves.toBeDefined();
  });

  it("requires a code", async () => {
    const s = await show();
    await expect(createSkid(s.id, { code: "   " })).rejects.toThrow(UserError);
  });
});

describe("packOntoSkid", () => {
  it("records which skid and when", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    const p = await piece(s.id, 'PVC (White) - 1/8"', "A1");

    await packOntoSkid(p.id, skid.id);
    const after = await db.artworkOrder.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.skidId).toBe(skid.id);
    expect(after.packedAt).not.toBeNull();
  });

  it("refuses a skid belonging to another show", async () => {
    const [a, b] = [await show("Seatrade"), await show("PGA")];
    const otherSkid = await createSkid(b.id, { code: "Item A" });
    const p = await piece(a.id, "Vinyl (White)", "A1");
    // This is how graphics arrive at the wrong venue.
    await expect(packOntoSkid(p.id, otherSkid.id)).rejects.toThrow(/different show/);
  });

  it("refuses a skid that has already shipped", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    const first = await piece(s.id, "Vinyl (White)", "A1");
    await packOntoSkid(first.id, skid.id);
    await markSkidSent(skid.id);

    const late = await piece(s.id, "Vinyl (White)", "A2");
    await expect(packOntoSkid(late.id, skid.id)).rejects.toThrow(/already shipped/);
  });

  it("unpacks a piece again", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    const p = await piece(s.id, "Vinyl (White)", "A1");
    await packOntoSkid(p.id, skid.id);
    await packOntoSkid(p.id, null);

    const after = await db.artworkOrder.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.skidId).toBeNull();
    expect(after.packedAt).toBeNull();
  });
});

describe("markSkidSent", () => {
  it("refuses an empty skid", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    await expect(markSkidSent(skid.id)).rejects.toThrow(/nothing packed on it/);
  });

  it("refuses to send the same skid twice", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    await packOntoSkid((await piece(s.id, "Vinyl (White)", "A1")).id, skid.id);
    await markSkidSent(skid.id);
    await expect(markSkidSent(skid.id)).rejects.toThrow(/already marked as sent/);
  });

  it("records the time, not just the date", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    await packOntoSkid((await piece(s.id, "Vinyl (White)", "A1")).id, skid.id);
    const at = new Date("2027-04-01T14:32:00Z");
    expect((await markSkidSent(skid.id, at)).sentAt?.toISOString()).toBe(at.toISOString());
  });
});

describe("skidContents", () => {
  it("lists what is on a skid in the order it should be loaded", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    for (const [material, code] of [
      ["Fabric (Black-Back)", "D"],
      ['PVC (White) - 1/8"', "A"],
      ["Vinyl (White)", "C"],
    ] as const) {
      await packOntoSkid((await piece(s.id, material, code)).id, skid.id);
    }
    expect((await skidContents(skid.id)).map((p) => p.graphicCode)).toEqual(["A", "C", "D"]);
  });

  it("counts contents on the show's skid list", async () => {
    const s = await show();
    const skid = await createSkid(s.id, { code: "Item A" });
    await packOntoSkid((await piece(s.id, "Vinyl (White)", "A1")).id, skid.id);
    const [listed] = await listSkids(s.id);
    expect(listed._count.artworkOrders).toBe(1);
  });
});
