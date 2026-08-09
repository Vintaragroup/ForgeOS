import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDocumentText, extractPdfPageTexts, locateQuotePage } from "@/lib/ai/text-extraction";

const RFP_DIR = path.resolve(import.meta.dirname, "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");

describe("extractDocumentText", () => {
  it("extracts real text from the RFP PDF (unpdf)", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));

    const result = await extractDocumentText("RFP", "application/pdf", bytes);

    expect(result.status).toBe("COMPLETE");
    if (result.status === "COMPLETE") {
      expect(result.text).toContain("SUPER BOWL LXI");
      expect(result.text).toContain("Temporary Booth Build");
    }
  });

  it("extracts real text from the Vendor Services Agreement DOCX (mammoth)", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "Exhibit 2 - SBLXI - Vendor Services Agreement.docx"));

    const result = await extractDocumentText(
      "CONTRACT",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes,
    );

    expect(result.status).toBe("COMPLETE");
    if (result.status === "COMPLETE") {
      expect(result.text).toContain("Liquidated Damages");
    }
  });

  it("marks PRICING_SCHEDULE documents unsupported without reading any bytes", async () => {
    const result = await extractDocumentText("PRICING_SCHEDULE", "application/octet-stream", Buffer.from(""));
    expect(result).toEqual({
      status: "UNSUPPORTED",
      reason: "Pricing schedules are parsed directly, not summarized.",
    });
  });

  it("marks DRAWING documents unsupported -- CAD-exported PDFs aren't extractable body text", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "Appendix B - SBLXI - Bid Sets_Booths.pdf"));
    const result = await extractDocumentText("DRAWING", "application/pdf", bytes);
    expect(result.status).toBe("UNSUPPORTED");
  });
});

describe("extractPdfPageTexts / locateQuotePage", () => {
  it("finds the real page a real quote appears on, in the real RFP PDF", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));
    const pages = await extractPdfPageTexts(bytes);
    expect(pages.length).toBeGreaterThan(5);

    // A real substring pulled from a known page, round-tripped through the
    // same normalization locateQuotePage itself applies -- proves the
    // search actually works against this PDF's real per-page text, not a
    // synthetic fixture.
    const targetPageIndex = 3;
    const realSnippet = pages[targetPageIndex].slice(40, 90).trim();
    expect(realSnippet.length).toBeGreaterThan(20);

    expect(locateQuotePage(pages, realSnippet)).toBe(targetPageIndex + 1);
  });

  it("tolerates whitespace differences between the quote and the source text", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));
    const pages = await extractPdfPageTexts(bytes);
    const realSnippet = pages[3].slice(40, 90).trim();
    const withExtraWhitespace = realSnippet.replace(/ /g, "   ").toUpperCase();

    expect(locateQuotePage(pages, withExtraWhitespace)).toBe(4);
  });

  it("returns null for a quote that isn't in the document", () => {
    expect(locateQuotePage(["some page text"], "this text does not appear anywhere in this document")).toBeNull();
  });

  it("returns null for an empty or too-short quote rather than false-matching everything", () => {
    expect(locateQuotePage(["some page text"], "")).toBeNull();
    expect(locateQuotePage(["some page text"], "  ")).toBeNull();
  });
});
