import { describe, expect, it } from "vitest";
import { clientLabelOf, getAllClientsSummary } from "@/lib/graphics-breakdowns";
import type { GraphicsOrder } from "@/lib/artwork-hub";

// Only the fields these two functions read. Cast at the boundary rather
// than building a whole GraphicsOrder, which carries the full include.
function piece(input: {
  id: string;
  company?: string;
  opportunityId?: string;
  showName?: string;
  showId?: string;
  show?: string;
}): GraphicsOrder {
  return {
    id: input.id,
    status: "PACKAGED_READY",
    opportunity: input.company
      ? { id: input.opportunityId ?? "opp", company: { name: input.company }, showName: input.showName ?? "A show" }
      : null,
    show: input.showId ? { id: input.showId, name: input.show ?? "A show" } : null,
  } as unknown as GraphicsOrder;
}

describe("clientLabelOf", () => {
  it("names the client when there is one", () => {
    expect(clientLabelOf(piece({ id: "1", company: "Club Glove" }))).toBe("Club Glove");
  });

  it("names the show for a piece that belongs to no client", () => {
    // It used to say "PGA Hub" for every such piece, which put another
    // show's name on 282 Seatrade rows.
    expect(clientLabelOf(piece({ id: "2", showId: "s1", show: "Seatrade Cruise Global 2026" }))).toBe(
      "Seatrade Cruise Global 2026 (show pieces)",
    );
  });

  it("never says PGA for a show that isn't PGA", () => {
    expect(clientLabelOf(piece({ id: "3", showId: "s1", show: "Seatrade Cruise Global 2026" }))).not.toMatch(/PGA/);
  });
});

describe("getAllClientsSummary", () => {
  it("keeps two shows' own pieces apart", () => {
    // The old "__hub__" key merged every show's pieces into one row,
    // labelled after whichever was seen first.
    const rows = getAllClientsSummary([
      piece({ id: "1", showId: "seatrade", show: "Seatrade Cruise Global 2026" }),
      piece({ id: "2", showId: "seatrade", show: "Seatrade Cruise Global 2026" }),
      piece({ id: "3", showId: "pga", show: "PGA Show 2026" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.showLabel).sort()).toEqual(["PGA Show 2026", "Seatrade Cruise Global 2026"]);
    expect(rows.find((r) => r.showLabel === "Seatrade Cruise Global 2026")?.totalPieces).toBe(2);
  });

  it("links a show's pieces to the show", () => {
    const [row] = getAllClientsSummary([piece({ id: "1", showId: "seatrade", show: "Seatrade" })]);
    expect(row.href).toBe("/shows/seatrade");
  });

  it("still groups a client's pieces by opportunity", () => {
    const rows = getAllClientsSummary([
      piece({ id: "1", company: "Club Glove", opportunityId: "o1" }),
      piece({ id: "2", company: "Club Glove", opportunityId: "o1" }),
      piece({ id: "3", company: "Acme", opportunityId: "o2" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "Club Glove", totalPieces: 2, href: "/opportunities/o1" });
  });
});
