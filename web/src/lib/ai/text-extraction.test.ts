import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDocumentText } from "@/lib/ai/text-extraction";

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
