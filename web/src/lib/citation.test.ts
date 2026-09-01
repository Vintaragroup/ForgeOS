import { describe, expect, it } from "vitest";
import { citationHref, linkifyMentions, parseFreeTextDate } from "@/lib/citation";

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

  it("links a PDF fact to its located page and carries the quote for in-viewer highlighting", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc1", mimeType: "application/pdf" },
      { sourceQuote: "some quote", pageNumber: 6 },
    );
    expect(href).toBe("/opportunities/opp1/documents/doc1/view?page=6&q=some%20quote");
  });

  it("links a PDF fact to its page alone when there's no quote to highlight", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc1", mimeType: "application/pdf" },
      { sourceQuote: "", pageNumber: 6 },
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

  it("links an XLSX fact to a cell-search highlight, same fragment convention as DOCX", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc3", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { sourceQuote: "Complete Booth Build", pageNumber: null },
    );
    expect(href).toBe("/opportunities/opp1/documents/doc3/view?q=Complete%20Booth%20Build#hl");
  });

  it("links a raw-image drawing fact to the document itself, no page/quote concept", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc4", mimeType: "image/png" },
      { sourceQuote: "", pageNumber: 1 },
    );
    expect(href).toBe("/opportunities/opp1/documents/doc4/view");
  });

  it("returns null for an image fact with no page number", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc4", mimeType: "image/png" },
      { sourceQuote: "", pageNumber: null },
    );
    expect(href).toBeNull();
  });

  it("returns null for a genuinely unsupported mime type", () => {
    const href = citationHref(
      opportunityId,
      { id: "doc5", mimeType: "application/octet-stream" },
      { sourceQuote: "some quote", pageNumber: 2 },
    );
    expect(href).toBeNull();
  });
});

describe("linkifyMentions", () => {
  const opportunityId = "opp1";
  const documents = [
    { id: "doc1", filename: "RFP Final.pdf" },
    { id: "doc2", filename: "Vendor Services Agreement.docx" },
  ];
  const lineItems = [
    { id: "li1", estimateId: "est1", description: "10x10 aluminum frame structure" },
    { id: "li2", estimateId: "est1", description: "Labor" },
  ];

  it("links a real filename mentioned in the reply, leaving surrounding text untouched", () => {
    const result = linkifyMentions('The rate is in "Vendor Services Agreement.docx".', opportunityId, documents);

    expect(result).toBe('The rate is in "[Vendor Services Agreement.docx](/opportunities/opp1/documents/doc2/view)".');
  });

  it("links every distinct filename mentioned, in order", () => {
    const result = linkifyMentions(
      "See RFP Final.pdf for dates and Vendor Services Agreement.docx for terms.",
      opportunityId,
      documents,
    );

    expect(result).toBe(
      "See [RFP Final.pdf](/opportunities/opp1/documents/doc1/view) for dates and " +
        "[Vendor Services Agreement.docx](/opportunities/opp1/documents/doc2/view) for terms.",
    );
  });

  it("returns the text unchanged when nothing matches", () => {
    expect(linkifyMentions("Nothing relevant mentioned here.", opportunityId, documents)).toBe(
      "Nothing relevant mentioned here.",
    );
  });

  it("returns the text unchanged when there are no documents or line items", () => {
    expect(linkifyMentions("RFP Final.pdf", opportunityId, [])).toBe("RFP Final.pdf");
  });

  it("links a line item description long enough to be distinctive, to its estimate anchor", () => {
    const result = linkifyMentions("That's the 10x10 aluminum frame structure you added.", opportunityId, [], lineItems);

    expect(result).toBe("That's the [10x10 aluminum frame structure](/estimates/est1#line-item-li1) you added.");
  });

  it("does not link a description too short/generic to be a safe match", () => {
    const result = linkifyMentions("Labor is the biggest cost driver here.", opportunityId, [], lineItems);

    expect(result).toBe("Labor is the biggest cost driver here.");
  });
});
