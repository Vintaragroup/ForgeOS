import { describe, expect, it } from "vitest";
import { parseTrackerCsv, splitPrintOrder, stripListSchemaPreamble, summarize } from "@/lib/graphics-tracker-import";

// Rows lifted verbatim from "Seatrade Cruise Global - 260407.csv".
const HEADER = [
  "SM or EXH", "Print Order", "Sent to Showsite", "Section", "Booth", "Approval",
  "AM/PM", "GO", "Shop", "Print Status", "Packed", "Special Instructions",
  "OS Sent By:", "O.S Proof", "OS In-Hand Date", "Approval status",
];

function row(overrides: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    "SM or EXH": "EXH",
    "Print Order": "1 - Boll Filter",
    "Sent to Showsite": '["Yes"]',
    Section: "Section 4 (1800-2299)",
    Booth: "1957",
    Approval: '["Approved"]',
    "AM/PM": "shurtado@expocci.com",
    GO: "Reserved_ImageAttachment_[2]_[GO][32]_[abc][2]_[12].png",
    Shop: '["Expo","Procedes llc"]',
    "Print Status": '["Completed","O.S Received"]',
    Packed: '["Completed"]',
    "Special Instructions": "",
    "OS Sent By:": "",
    "O.S Proof": "",
    "OS In-Hand Date": "2026-02-02T08:00:00Z",
    "Approval status": "0",
    ...overrides,
  };
  return HEADER.map((h) => base[h] ?? "");
}

const parse = (...dataRows: string[][]) => parseTrackerCsv([HEADER, ...dataRows]);

describe("stripListSchemaPreamble", () => {
  it("cuts the schema blob at the header line, not at the blob's own mention of it", () => {
    // The real export carries "SM or EXH" inside the schema as a column
    // DisplayName ~27,000 characters before the header itself. Cutting at
    // that first occurrence loses the header entirely.
    const raw = 'ListSchema={"x":"... DisplayName=\\"SM or EXH\\" ..."}\n"SM or EXH","Print Order"\nEXH,1 - Acme';
    expect(stripListSchemaPreamble(raw).startsWith('"SM or EXH","Print Order"')).toBe(true);
  });

  it("leaves a file that already starts with the header alone", () => {
    const raw = '"SM or EXH","Print Order"\nEXH,1 - Acme';
    expect(stripListSchemaPreamble(raw)).toBe(raw);
  });
});

describe("parseTrackerCsv", () => {
  it("refuses a file whose header it cannot find, rather than mapping everything to null", () => {
    // Silently returning 282 empty rows and reporting no problems is worse
    // than failing: it looks like success.
    expect(() => parseTrackerCsv([["something", "else"], ["a", "b"]])).toThrow(/Could not find the header row/);
  });

  it("reads the three order types her column holds", () => {
    const rows = parse(row({ "SM or EXH": "EXH" }), row({ "SM or EXH": "SM" }), row({ "SM or EXH": "Site" }));
    expect(rows.map((r) => r.orderType)).toEqual(["EXHIBITOR", "SHOW_MANAGEMENT", "SITE"]);
  });

  it("pairs a split piece's two shops with their own statuses", () => {
    const [r] = parse(row());
    expect(r.halves).toEqual([
      { kind: "EXPO_IN_HOUSE", shopName: null, normalizedShopName: null, productionStatus: "COMPLETED" },
      expect.objectContaining({ kind: "VENDOR", shopName: "Procedes llc", productionStatus: "OS_RECEIVED" }),
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("pairs by vocabulary, not position, so a reversed status array still lands correctly", () => {
    const [r] = parse(row({ "Print Status": '["O.S Received","Completed"]' }));
    expect(r.halves.find((h) => h.kind === "EXPO_IN_HOUSE")?.productionStatus).toBe("COMPLETED");
    expect(r.halves.find((h) => h.kind === "VENDOR")?.productionStatus).toBe("OS_RECEIVED");
  });

  it("treats STORAGE as provenance, not a production status", () => {
    const [r] = parse(row({ Shop: '["Expo"]', "Print Status": '["STORAGE","Completed"]' }));
    expect(r.fromStorage).toBe(true);
    expect(r.halves).toHaveLength(1);
    expect(r.halves[0].productionStatus).toBe("COMPLETED");
    expect(r.warnings).toEqual([]);
  });

  it("names a status it could not attach instead of just counting it", () => {
    // Real row: one outsourced shop, but an in-house status too.
    const [r] = parse(row({ Shop: '["Binca - Miami"]', "Print Status": '["Completed"]' }));
    expect(r.warnings[0]).toContain("COMPLETED");
    // And it does not guess -- the vendor half stays at its default.
    expect(r.halves[0].productionStatus).toBe("OS_NOT_SENT");
  });

  it("recognises AM/PM as a routing outcome rather than a shop", () => {
    const [r] = parse(row({ Shop: '["AE / PM"]', "Print Status": '["Completed"]' }));
    expect(r.halves[0].kind).toBe("AM_PM_COORDINATED");
  });

  it("splits the sequence from the title, and only calls it a client on an exhibitor row", () => {
    const [exh, sm] = parse(
      row({ "Print Order": "1 - Boll Filter" }),
      row({ "SM or EXH": "SM", "Print Order": "307C- Sales Suite (Booth No. 1238)" }),
    );
    expect(exh).toMatchObject({ sequence: "1", title: "Boll Filter", clientName: "Boll Filter" });
    expect(sm).toMatchObject({ sequence: "307C", title: "Sales Suite (Booth No. 1238)", clientName: null });
  });

  it("reads the in-hand date and the booth", () => {
    const [r] = parse(row());
    expect(r.inHandDate?.toISOString().slice(0, 10)).toBe("2026-02-02");
    expect(r.boothNumber).toBe(1957);
  });

  it("refuses to place a booth it can't read on the floor", () => {
    // Real values from the export: show management, and a two-booth cell.
    expect(parse(row({ Booth: "SM" }))[0].boothNumber).toBeNull();
    expect(parse(row({ Booth: "927 1027" }))[0].boothNumber).toBeNull();
  });

  it("picks the skid code out of the Packed column, which also carries a status", () => {
    const [r] = parse(row({ Packed: '["Item C"]' }));
    expect(r.skidCode).toBe("Item C");
    expect(r.packed).toBe(false);
  });

  it("reads cancellation from the Approval column", () => {
    expect(parse(row({ Approval: '["Cancelled"]' }))[0].cancelled).toBe(true);
    expect(parse(row())[0].cancelled).toBe(false);
  });
});

describe("splitPrintOrder", () => {
  it("handles the spacing her team actually types", () => {
    expect(splitPrintOrder("2- Nevetal")).toEqual({ sequence: "2", title: "Nevetal" });
    expect(splitPrintOrder("1 - Boll Filter")).toEqual({ sequence: "1", title: "Boll Filter" });
    expect(splitPrintOrder("SITE 3- Products B&B Vinyl")).toEqual({ sequence: "SITE 3", title: "Products B&B Vinyl" });
  });

  it("keeps the whole string when there is no sequence", () => {
    expect(splitPrintOrder("Check in Desks")).toEqual({ sequence: null, title: "Check in Desks" });
  });
});

describe("summarize", () => {
  it("counts halves across rows, not rows", () => {
    const s = summarize(parse(row(), row({ Shop: '["Expo"]', "Print Status": '["Completed"]' })));
    expect(s.rows).toBe(2);
    expect(s.halves).toBe(3);
    expect(s.distinctShops).toEqual(["Procedes llc"]);
  });
});
