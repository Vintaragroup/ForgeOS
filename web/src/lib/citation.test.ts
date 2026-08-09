import { describe, expect, it } from "vitest";
import { citationHref, linkifyDocumentMentions, parseFreeTextDate } from "@/lib/citation";

describe("parseFreeTextDate", () => {
  it("parses a plain date the Date constructor already understands", () => {
    const d = parseFreeTextDate("August 31, 2026");
    expect(d).not.toBeNull();
    expect(d?.getUTCFullYear()).toBe(2026);
  });

  it("collapses a date range to its start date -- real example from the RFP's own Event Schedule", () => {
    const d = parseFreeTextDate("August 17-20, 2026");
    expect(d).not.toBeNull();
    expect(d?.getUTCMonth()).toBe(7); // August, 0-indexed
    expect(d?.getUTCDate()).toBe(17);
    expect(d?.getUTCFullYear()).toBe(2026);
  });

  it("collapses a day-first range too -- real example from an Appendix Event Schedule", () => {
    const d = parseFreeTextDate("17-20 August 2026");
    expect(d).not.toBeNull();
    expect(d?.getUTCMonth()).toBe(7); // August, 0-indexed
    expect(d?.getUTCDate()).toBe(17);
    expect(d?.getUTCFullYear()).toBe(2026);
  });

  it("returns null for text that isn't a date at all, rather than an Invalid Date", () => {
    expect(parseFreeTextDate("Not applicable")).toBeNull();
    expect(parseFreeTextDate("")).toBeNull();
  });
});

describe("citationHref", () => {
  const opportunityId = "opp1";

  it("links a PDF fact to its located page", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc1", mimeType: "application/pdf" },
      { sourceQuote: "some quote", pageNumber: 6 },
    );
    expect(href).toBe("/opportunities/opp1/documents/doc1/view?page=6");
  });

  it("returns null for a PDF fact with no located page", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc1", mimeType: "application/pdf" },
      { sourceQuote: "some quote", pageNumber: null },
    );
    expect(href).toBeNull();
  });

  it("links a DOCX fact to a quote-search highlight, URL-encoded", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc2", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { sourceQuote: "Liquidated Damages: 0.5%", pageNumber: null },
    );
    expect(href).toBe(
      "/opportunities/opp1/documents/doc2/view?q=Liquidated%20Damages%3A%200.5%25#hl",
    );
  });

  it("returns null for an unsupported mime type", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc3", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { sourceQuote: "some quote", pageNumber: 2 },
    );
    expect(href).toBeNull();
  });
});

describe("linkifyDocumentMentions", () => {
  const opportunityId = "opp1";
  const documents = [
    { id: "doc1", filename: "RFP Final.pdf" },
    { id: "doc2", filename: "Vendor Services Agreement.docx" },
  ];

  it("links a real filename mentioned in the reply, leaving surrounding text plain", () => {
    const segments = linkifyDocumentMentions(
      'The rate is in "Vendor Services Agreement.docx".',
      opportunityId,
      documents,
    );

    expect(segments.map((s) => s.text).join("")).toBe('The rate is in "Vendor Services Agreement.docx".');
    const linked = segments.find((s) => s.href);
    expect(linked?.text).toBe("Vendor Services Agreement.docx");
    expect(linked?.href).toBe("/opportunities/opp1/documents/doc2/view");
  });

  it("links every distinct filename mentioned, in order", () => {
    const segments = linkifyDocumentMentions(
      "See RFP Final.pdf for dates and Vendor Services Agreement.docx for terms.",
      opportunityId,
      documents,
    );
    const links = segments.filter((s) => s.href);
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe("/opportunities/opp1/documents/doc1/view");
    expect(links[1].href).toBe("/opportunities/opp1/documents/doc2/view");
  });

  it("returns the whole text as one plain segment when nothing matches", () => {
    const segments = linkifyDocumentMentions("Nothing relevant mentioned here.", opportunityId, documents);
    expect(segments).toEqual([{ text: "Nothing relevant mentioned here.", href: null }]);
  });

  it("returns the whole text as one plain segment when there are no documents", () => {
    const segments = linkifyDocumentMentions("RFP Final.pdf", opportunityId, []);
    expect(segments).toEqual([{ text: "RFP Final.pdf", href: null }]);
  });
});
