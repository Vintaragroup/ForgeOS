import { describe, expect, it } from "vitest";
import { buildBulletsBlock } from "@/lib/ai/scope-document-context";

describe("buildBulletsBlock", () => {
  it("lists each document's bullets with its verbatim quote", () => {
    const block = buildBulletsBlock([
      {
        filename: "Scope of Work.docx",
        bullets: [
          { text: "No target temperature range given for 'temperature-controlled' storage.", sourceQuote: "temperature-controlled storage" },
          { text: "No named owner for permit acquisition.", sourceQuote: "permits as required" },
        ],
      },
    ]);
    expect(block).toContain("Document: Scope of Work.docx");
    expect(block).toContain("No target temperature range given for 'temperature-controlled' storage.");
    expect(block).toContain('(quote: "temperature-controlled storage")');
    expect(block).toContain("No named owner for permit acquisition.");
  });

  it("marks a document with no bullets rather than leaving it blank -- older summaries predate this field", () => {
    const block = buildBulletsBlock([{ filename: "Old Summary.pdf", bullets: [] }]);
    expect(block).toContain("Document: Old Summary.pdf");
    expect(block).toContain("(none extracted)");
  });

  it("separates multiple documents with a divider", () => {
    const block = buildBulletsBlock([
      { filename: "a.pdf", bullets: [{ text: "Gap A", sourceQuote: "quote a" }] },
      { filename: "b.pdf", bullets: [{ text: "Gap B", sourceQuote: "quote b" }] },
    ]);
    const [first, second] = block.split("\n\n---\n\n");
    expect(first).toContain("Document: a.pdf");
    expect(first).toContain("Gap A");
    expect(second).toContain("Document: b.pdf");
    expect(second).toContain("Gap B");
  });
});
