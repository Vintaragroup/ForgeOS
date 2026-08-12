import { describe, expect, it } from "vitest";
import { buildScopeDocumentsBlock, MAX_SCOPE_DOCUMENT_CHARS } from "@/lib/ai/scope-document-context";

function docBlockLength(block: string, filename: string): number {
  const marker = `Document: ${filename}\n\n`;
  const start = block.indexOf(marker) + marker.length;
  const end = block.indexOf("\n\n---\n\n", start);
  return (end === -1 ? block.length : end) - start;
}

describe("buildScopeDocumentsBlock", () => {
  it("includes every document's full text unclipped when the total fits well under budget", () => {
    const documents = [
      { filename: "short.pdf", extractedText: "a".repeat(1_000) },
      { filename: "medium.pdf", extractedText: "b".repeat(20_000) },
    ];
    const block = buildScopeDocumentsBlock(documents);
    expect(docBlockLength(block, "short.pdf")).toBe(1_000);
    expect(docBlockLength(block, "medium.pdf")).toBe(20_000);
  });

  it("gives a short document only what it actually needs, not a wasted equal share", () => {
    // Real shape of the bug this fixes: a 1,085-char document under a
    // naive equal split with 5 documents would still be allocated
    // MAX/5 = 50,000 characters, wasting ~49,000 of its own share.
    const documents = [
      { filename: "tiny.pdf", extractedText: "a".repeat(1_085) },
      { filename: "big.pdf", extractedText: "b".repeat(300_000) },
    ];
    const block = buildScopeDocumentsBlock(documents);
    expect(docBlockLength(block, "tiny.pdf")).toBe(1_085);
    // The tiny document's unused slack goes to the big one instead of
    // being wasted -- it gets more than a blind 50/50 split would give it.
    expect(docBlockLength(block, "big.pdf")).toBe(MAX_SCOPE_DOCUMENT_CHARS - 1_085);
  });

  it("clips proportionally, largest documents first, only once the real total exceeds budget", () => {
    const documents = [
      { filename: "a.pdf", extractedText: "x".repeat(100_000) },
      { filename: "b.pdf", extractedText: "y".repeat(100_000) },
      { filename: "c.pdf", extractedText: "z".repeat(100_000) },
    ];
    const block = buildScopeDocumentsBlock(documents);
    // 300,000 real chars against a 250,000 budget, all three equally
    // sized -- water-filling degrades to an even split (within a
    // 1-character floor-division remainder) when every document is the
    // same size, same as a naive split would here.
    const lengths = [
      docBlockLength(block, "a.pdf"),
      docBlockLength(block, "b.pdf"),
      docBlockLength(block, "c.pdf"),
    ];
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    expect(Math.max(...lengths)).toBeLessThan(100_000);
    expect(lengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_SCOPE_DOCUMENT_CHARS);
  });

  it("labels each document with a 'Document: <filename>' header", () => {
    const block = buildScopeDocumentsBlock([{ filename: "Scope of Work.docx", extractedText: "some text" }]);
    expect(block).toContain("Document: Scope of Work.docx");
    expect(block).toContain("some text");
  });
});
