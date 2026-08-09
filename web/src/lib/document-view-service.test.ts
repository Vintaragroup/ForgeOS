import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSpreadsheetMatch, highlightQuote, renderDocx, renderSpreadsheet } from "@/lib/document-view-service";

const RFP_DIR = path.resolve(import.meta.dirname, "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");

describe("renderSpreadsheet", () => {
  it("renders every real sheet of the Exhibit 1 workbook as a table, header row included", async () => {
    const bytes = await readFile(
      path.join(RFP_DIR, "Exhibit 1 - SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx"),
    );

    const sheets = await renderSpreadsheet(bytes);

    expect(sheets.map((s) => s.name)).toEqual(["1. Instructions & Summary", "2. Pricing Schedule"]);
    const pricingSheet = sheets[1];
    expect(pricingSheet.rows.length).toBeGreaterThan(100);
    // The header row itself should be visible in the rendered table, unlike
    // pricing-import-service.ts's parser which treats it as structural.
    const headerRow = pricingSheet.rows.find((r) => r.includes("Category"));
    expect(headerRow).toBeDefined();
    expect(headerRow).toContain("Description");
  });
});

describe("findSpreadsheetMatch", () => {
  it("finds the real cell a pricing-schedule row's own Description text came from", async () => {
    const bytes = await readFile(
      path.join(RFP_DIR, "Exhibit 1 - SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx"),
    );
    const sheets = await renderSpreadsheet(bytes);

    // A real cell's own full text, pulled from the rendered sheet itself
    // (not a guessed/truncated string) -- proves the round trip: whatever
    // pricing-import-service.ts would store as sourceQuote, this function
    // can find again in the same rendered table.
    const pricingSheet = sheets.find((s) => s.name === "2. Pricing Schedule")!;
    const realCell = pricingSheet.rows.flat().find((cell) => cell.includes("Complete Booth Build"))!;
    expect(realCell).toBeTruthy();

    const match = findSpreadsheetMatch(sheets, realCell);
    expect(match).not.toBeNull();
    expect(sheets[match!.sheetIndex].rows[match!.rowIndex][match!.cellIndex]).toBe(realCell);
  });

  it("tolerates whitespace/case differences between the stored quote and the cell", async () => {
    const sheets = [{ name: "Sheet1", rows: [["Category", "Description"], ["A", "  Complete   Booth Build  "]] }];
    const match = findSpreadsheetMatch(sheets, "complete booth build");
    expect(match).toEqual({ sheetIndex: 0, rowIndex: 1, cellIndex: 1 });
  });

  it("returns null for a quote that isn't in any sheet", () => {
    const sheets = [{ name: "Sheet1", rows: [["A", "B"]] }];
    expect(findSpreadsheetMatch(sheets, "nothing like this exists")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    const sheets = [{ name: "Sheet1", rows: [["A", "B"]] }];
    expect(findSpreadsheetMatch(sheets, "")).toBeNull();
  });
});

describe("renderDocx", () => {
  it("renders the real Vendor Services Agreement as HTML with formatting preserved", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "Exhibit 2 - SBLXI - Vendor Services Agreement.docx"));

    const html = await renderDocx(bytes);

    expect(html).toContain("Liquidated Damages");
    // mammoth should have produced real structural tags, not plain text.
    expect(html).toMatch(/<p>|<table>|<h\d>/);
  });

  it("strips script tags defensively even though mammoth doesn't produce them", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "Exhibit 2 - SBLXI - Vendor Services Agreement.docx"));
    const html = await renderDocx(bytes);
    expect(html).not.toContain("<script");
  });
});

describe("highlightQuote", () => {
  it("wraps a real quote found in the real Vendor Services Agreement HTML with an id='hl' mark", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "Exhibit 2 - SBLXI - Vendor Services Agreement.docx"));
    const html = await renderDocx(bytes);

    const highlighted = highlightQuote(html, "Liquidated Damages");

    expect(highlighted).toContain('<mark id="hl"');
    expect(highlighted).toContain("Liquidated Damages</mark>");
    // Nothing else in the document changed.
    expect(highlighted.length).toBeGreaterThan(html.length);
    expect(highlighted.replace(/<mark id="hl"[^>]*>|<\/mark>/g, "")).toBe(html);
  });

  it("tolerates whitespace differences between the quote and the rendered HTML", async () => {
    const html = "<p>The quick brown fox jumps over the lazy dog.</p>";
    const highlighted = highlightQuote(html, "quick   brown\nfox");
    expect(highlighted).toContain('<mark id="hl"');
  });

  it("returns the HTML unchanged when the quote isn't found", () => {
    const html = "<p>Nothing relevant here.</p>";
    expect(highlightQuote(html, "a quote that does not exist")).toBe(html);
  });

  it("returns the HTML unchanged for an empty quote", () => {
    const html = "<p>Some content.</p>";
    expect(highlightQuote(html, "")).toBe(html);
  });
});
