import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  buildBulletsBlock,
  filterBulletsForEstimate,
  getProjectContext,
  resolveProjectTag,
} from "@/lib/ai/scope-document-context";

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

describe("filterBulletsForEstimate", () => {
  it("keeps shared/unclassified bullets (null or missing estimateId) alongside the target estimate's own", () => {
    const bullets = [
      { text: "shared fact", sourceQuote: "q1", estimateId: null },
      { text: "unclassified (old summary)", sourceQuote: "q2" },
      { text: "belongs to A", sourceQuote: "q3", estimateId: "est-a" },
      { text: "belongs to B", sourceQuote: "q4", estimateId: "est-b" },
    ];

    const forA = filterBulletsForEstimate(bullets, "est-a");

    expect(forA.map((b) => b.text)).toEqual(["shared fact", "unclassified (old summary)", "belongs to A"]);
  });
});

describe("resolveProjectTag", () => {
  it("matches a project name case/whitespace-insensitively", () => {
    const context = { estimates: [{ id: "est-a", name: "Full Swing Baseball" }, { id: "est-b", name: "Full Swing PGA" }] };
    expect(resolveProjectTag("  full swing baseball ", context)).toBe("est-a");
    expect(resolveProjectTag("Full Swing PGA", context)).toBe("est-b");
  });

  it("falls back to null (shared) for SHARED, a hallucinated name, or no estimates in context", () => {
    const context = { estimates: [{ id: "est-a", name: "Full Swing Baseball" }, { id: "est-b", name: "Full Swing PGA" }] };
    expect(resolveProjectTag("SHARED", context)).toBeNull();
    expect(resolveProjectTag("A completely made-up project", context)).toBeNull();
    expect(resolveProjectTag(null, context)).toBeNull();
    expect(resolveProjectTag(undefined, context)).toBeNull();
    expect(resolveProjectTag("Full Swing Baseball", { estimates: [] })).toBeNull();
  });
});

describe("getProjectContext", () => {
  afterEach(async () => {
    await db.estimate.deleteMany();
    await db.opportunity.deleteMany();
    await db.company.deleteMany();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function makeOpportunity() {
    const company = await db.company.create({ data: { name: "Test Co" } });
    return db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  }

  it("returns an empty array for the common single-estimate case, even if that estimate is named", async () => {
    const opportunity = await makeOpportunity();
    await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Only One" } });

    const context = await getProjectContext(opportunity.id);

    expect(context.estimates).toEqual([]);
  });

  it("returns real id+name pairs once there are 2+ named estimates", async () => {
    const opportunity = await makeOpportunity();
    const a = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Full Swing Baseball" } });
    const b = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Full Swing PGA" } });

    const context = await getProjectContext(opportunity.id);

    expect(context.estimates).toEqual(
      expect.arrayContaining([
        { id: a.id, name: "Full Swing Baseball" },
        { id: b.id, name: "Full Swing PGA" },
      ]),
    );
  });

  it("ignores an unnamed estimate when counting toward the 2+ threshold", async () => {
    const opportunity = await makeOpportunity();
    await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Named One" } });
    await db.estimate.create({ data: { opportunityId: opportunity.id } }); // no name

    const context = await getProjectContext(opportunity.id);

    expect(context.estimates).toEqual([]);
  });
});
