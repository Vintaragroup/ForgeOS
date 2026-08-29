import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractDocumentText,
  extractPdfPageTexts,
  locateQuotePage,
  resolveHighlightableQuote,
} from "@/lib/ai/text-extraction";

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

  it("extracts a .md file's raw text when the browser reports a real markdown mimeType", async () => {
    const bytes = Buffer.from("# Kickoff Notes\n\n- Booth build due 2026-09-01\n- Client wants FR carpet quoted separately");
    const result = await extractDocumentText("MEETING_NOTES", "text/markdown", bytes, "kickoff-notes.md");
    expect(result.status).toBe("COMPLETE");
    if (result.status === "COMPLETE") {
      expect(result.text).toContain("Booth build due 2026-09-01");
    }
  });

  it("falls back to the .md filename extension when the mimeType is empty or generic -- confirmed real browser behavior for Markdown uploads", async () => {
    const bytes = Buffer.from("# Scope notes\n\nSee Section 211 for camera booth requirements.");
    const emptyMime = await extractDocumentText("SCOPE_OF_WORK", "", bytes, "scope-notes.md");
    const octetStream = await extractDocumentText("SCOPE_OF_WORK", "application/octet-stream", bytes, "scope-notes.md");
    expect(emptyMime.status).toBe("COMPLETE");
    expect(octetStream.status).toBe("COMPLETE");
  });

  it("does not misdetect an unrelated octet-stream file as markdown just because it's some other unresolved type", async () => {
    const result = await extractDocumentText("OTHER", "application/octet-stream", Buffer.from("binary-ish content"), "drawing.dwg");
    expect(result.status).toBe("UNSUPPORTED");
  });

  it("reports an empty .md file as unsupported, same as an empty .txt file", async () => {
    const result = await extractDocumentText("OTHER", "text/markdown", Buffer.from("   \n  "), "empty.md");
    expect(result).toEqual({ status: "UNSUPPORTED", reason: "This text file is empty." });
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

describe("resolveHighlightableQuote", () => {
  const source = "Daily rate of Liquidated Damages: One-half percent (0.5%) of the Fee. Some unrelated clause about insurance sits in between. The amount payable shall be capped at ten percent (10%) of the Fee.";

  it("returns the quote unchanged when it's already a real contiguous substring", () => {
    const quote = "One-half percent (0.5%) of the Fee";
    expect(resolveHighlightableQuote(source, quote)).toBe(quote);
  });

  it("falls back to a matchable prefix for a quote stitched together from two separate clauses -- the real shape an AI risk-flag quote took in production", () => {
    const stitchedQuote =
      "Daily rate of Liquidated Damages: One-half percent (0.5%) of the Fee\nThe amount payable shall be capped at ten percent (10%) of the Fee.";
    const resolved = resolveHighlightableQuote(source, stitchedQuote);
    expect(source.toLowerCase()).toContain(resolved.toLowerCase());
    expect(resolved.length).toBeLessThan(stitchedQuote.length);
  });

  it("returns the original quote unchanged when not even a short prefix is genuinely contiguous", () => {
    const quote = "this text never appears in the source document at all";
    expect(resolveHighlightableQuote(source, quote)).toBe(quote);
  });
});
