import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderDocx, renderSpreadsheet } from "@/lib/document-view-service";

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
