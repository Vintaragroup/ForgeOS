import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToBuffer, Document, Page, Text } from "@react-pdf/renderer";
import {
  findSpreadsheetMatch,
  getPdfPageDimensionsInInches,
  highlightQuote,
  renderDocx,
  renderPdfPageToPng,
  renderSpreadsheet,
  stripDangerousHtml,
} from "@/lib/document-view-service";
import { buildTaskPacketData, TaskPacketPdfDocument } from "@/lib/task-packet-pdf";

// A one-page PDF at an EXACT, known point size -- unlike makeOnePagePdf's
// "LETTER" preset below, this lets getPdfPageDimensionsInInches's inch
// conversion be checked precisely (72pt = 1in is a fixed PDF convention,
// not a guess) rather than just "returns something." Document/Page/Text
// are @react-pdf/renderer's own host-element type identifiers (plain
// strings, not components), so this file (no JSX) has to build the tree
// with createElement directly rather than calling them.
async function makeFixedSizePdf(widthPt: number, heightPt: number): Promise<Buffer> {
  return renderToBuffer(
    createElement(
      Document,
      null,
      createElement(Page, { size: [widthPt, heightPt] }, createElement(Text, null, "fixed size fixture")),
    ),
  );
}

const RFP_DIR = path.resolve(import.meta.dirname, "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");

// A minimal real one-page PDF -- reuses TaskPacketPdfDocument (an existing,
// already-tested @react-pdf/renderer Document in this codebase) purely as
// a source of real, valid PDF bytes to exercise renderPdfPageToPng's
// actual pdf.js parsing and canvas rasterization, not a hand-rolled/fake
// buffer.
async function makeOnePagePdf(): Promise<Buffer> {
  const data = buildTaskPacketData({
    showName: "Test Show",
    companyName: "Test Co",
    jobNumber: null,
    taskDescription: "renderPdfPageToPng test fixture",
    departmentCode: null,
    departmentName: null,
    vendorName: null,
    dueDate: null,
    lineItems: [],
  });
  return renderToBuffer(TaskPacketPdfDocument({ data }));
}

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

// Item #2 of the security/hardening roadmap: stripDangerousHtml used to
// be a regex blocklist (`/<script\b[^>]*>[\s\S]*?<\/script>/gi` +
// `/\son\w+="[^"]*"/gi`) -- these cases are concrete, real bypasses of
// THAT specific regex (not hypothetical), each one now caught by
// DOMPurify's allowlist approach instead.
describe("stripDangerousHtml -- real bypasses of the old regex blocklist", () => {
  it("strips an unquoted event handler attribute (the old regex only matched a double-quoted value)", () => {
    const result = stripDangerousHtml('<img src="x" onerror=alert(1)>');
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("alert(1)");
  });

  it("strips a single-quoted event handler attribute (the old regex only matched double quotes)", () => {
    const result = stripDangerousHtml("<svg onload='alert(1)'>");
    expect(result).not.toContain("onload");
    expect(result).not.toContain("alert(1)");
  });

  it("strips a javascript: URI in an href (the old regex never inspected attribute VALUES beyond on*=)", () => {
    const result = stripDangerousHtml('<a href="javascript:alert(1)">click</a>');
    expect(result.toLowerCase()).not.toContain("javascript:");
  });

  it("strips a script tag with no closing tag (the old regex required a matching </script>)", () => {
    const result = stripDangerousHtml('<p>before</p><script src="evil.js">');
    expect(result).not.toContain("<script");
  });

  it("still preserves ordinary safe formatting content untouched", () => {
    const html = "<p>Hello <strong>world</strong>, see <a href=\"https://example.com\">this link</a>.</p>";
    expect(stripDangerousHtml(html)).toBe(html);
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

describe("renderPdfPageToPng", () => {
  it("rasterizes a real PDF's first page into a PNG data URL", async () => {
    const bytes = await makeOnePagePdf();
    const dataUrl = await renderPdfPageToPng(bytes, 1);
    expect(dataUrl).not.toBeNull();
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    // A real rasterized page is not a tiny/empty image.
    const base64 = dataUrl!.slice("data:image/png;base64,".length);
    expect(Buffer.from(base64, "base64").length).toBeGreaterThan(1000);
  });

  it("returns null for a page number beyond the document's real page count", async () => {
    const bytes = await makeOnePagePdf();
    expect(await renderPdfPageToPng(bytes, 99)).toBeNull();
  });

  it("returns null instead of throwing for bytes that aren't a real PDF at all (e.g. an .ai file)", async () => {
    const notAPdf = Buffer.from("this is not a PDF file");
    expect(await renderPdfPageToPng(notAPdf, 1)).toBeNull();
  });
});

describe("getPdfPageDimensionsInInches", () => {
  it("converts a page's exact point size to inches (72pt = 1in)", async () => {
    // 5in x 10in at the fixed 72pt/in PDF convention.
    const bytes = await makeFixedSizePdf(360, 720);
    const dims = await getPdfPageDimensionsInInches(bytes, 1);
    expect(dims).not.toBeNull();
    expect(dims!.widthIn).toBeCloseTo(5, 5);
    expect(dims!.heightIn).toBeCloseTo(10, 5);
  });

  it("converts a non-round point size precisely, not just a plausible-looking value", async () => {
    const bytes = await makeFixedSizePdf(252, 90); // 3.5in x 1.25in
    const dims = await getPdfPageDimensionsInInches(bytes, 1);
    expect(dims!.widthIn).toBeCloseTo(3.5, 5);
    expect(dims!.heightIn).toBeCloseTo(1.25, 5);
  });

  it("returns null for a page number beyond the document's real page count", async () => {
    const bytes = await makeFixedSizePdf(360, 720);
    expect(await getPdfPageDimensionsInInches(bytes, 99)).toBeNull();
  });

  it("returns null instead of throwing for bytes that aren't a real PDF at all", async () => {
    const notAPdf = Buffer.from("this is not a PDF file");
    expect(await getPdfPageDimensionsInInches(notAPdf, 1)).toBeNull();
  });
});
