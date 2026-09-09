import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createEstimateVersion } from "@/lib/estimate-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  buildProposalSchema,
  buildSystemPrompt,
  commitScopeLineItems,
  flagUncertainClassifications,
  loadDuplicateCandidates,
  proposeLineItemsFromScope,
  SCOPE_CATEGORIES,
  type ProposedLineItem,
} from "@/lib/ai/scope-line-item-service";
import type { ProjectContext } from "@/lib/ai/scope-document-context";
import { findExactDuplicates, type ProposedItemForDuplicateCheck } from "@/lib/ai/line-item-duplicate-service";

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.lineItemAccuracyFlag.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.rentalItem.deleteMany();
  await db.material.deleteMany();
  await db.category.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

// mimeType defaults to DOCX, not PDF -- commitScopeLineItems fetches real
// bytes off disk to compute a page number for a PDF source (see
// text-extraction.ts's extractPdfPageTexts), which this fixture's fake
// storageKey doesn't have. DOCX has no page concept, so it exercises the
// "no page lookup" path cleanly without needing a real file on disk.
async function makeAnalyzedDocument(extractedText: string | null, mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "Scope of Work.docx",
      mimeType,
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "SCOPE_OF_WORK",
      extractionStatus: extractedText ? "COMPLETE" : "PENDING",
      extractedText,
    },
  });
}

describe("proposeLineItemsFromScope", () => {
  it("refuses to propose items for a document that hasn't been analyzed yet, before ever touching the OpenAI client", async () => {
    const document = await makeAnalyzedDocument(null);

    await expect(proposeLineItemsFromScope(document.id, document.opportunityId)).rejects.toThrow(/hasn't been analyzed yet/);
  });

  it("throws AiNotConfiguredError for an analyzed document when no API key is set -- .env.test deliberately has none", async () => {
    const document = await makeAnalyzedDocument("Provide booth construction, graphics, and installation labor.");

    await expect(proposeLineItemsFromScope(document.id, document.opportunityId)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  // Regression test for the cross-resource ID authorization gap: this
  // previously trusted documentId alone -- see the function's own header
  // comment.
  it("rejects a documentId that belongs to a different opportunity, before ever touching the OpenAI client", async () => {
    const document = await makeAnalyzedDocument("Provide booth construction, graphics, and installation labor.");
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(proposeLineItemsFromScope(document.id, otherOpportunity.id)).rejects.toThrow();
  });
});

describe("commitScopeLineItems", () => {
  it("refuses to commit when no items have been proposed yet", async () => {
    const document = await makeAnalyzedDocument("some scope text");
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await expect(commitScopeLineItems(version.id, document.id)).rejects.toThrow(/Propose items first/);
  });

  // Replaces this suite's old "refuses a second commit" guard test -- the
  // real production incident (a Super Bowl 2026 estimate had this same
  // document's proposed items committed twice, with the AI regenerating
  // different category names each run so the duplicate sections didn't
  // even line up) is now caught by fresh Tier 1 exact-match detection
  // instead of an unconditional whole-document block, so a genuine
  // re-commit silently excludes only what's actually already there
  // instead of throwing. See line-item-duplicate-service.ts's own header
  // comment for the two-tier design this exercises.
  it("silently excludes an exact-duplicate item on a second commit of the same document, instead of throwing or re-inserting it", async () => {
    const document = await makeAnalyzedDocument("some scope text");
    const proposed: ProposedLineItem[] = [
      {
        description: "Booth walls",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const first = await commitScopeLineItems(version.id, document.id);
    expect(first.rowsImported).toBe(1);

    // No selectedIndices given -- safe default applies, no OpenAI call
    // needed since Tier 1 alone resolves this deterministically.
    const second = await commitScopeLineItems(version.id, document.id);
    expect(second.rowsImported).toBe(0);

    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id } });
    expect(sections).toHaveLength(1);
    const lineItemCount = await db.lineItem.count({ where: { section: { estimateVersionId: version.id } } });
    expect(lineItemCount).toBe(1);
  });

  it("re-adds a flagged duplicate when its index is explicitly passed back in -- proves a human can override the default", async () => {
    const document = await makeAnalyzedDocument("some scope text");
    const proposed: ProposedLineItem[] = [
      {
        description: "Booth walls",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitScopeLineItems(version.id, document.id);
    // Explicitly re-selecting index 0 (the only proposed item) forces it
    // back in despite it being an exact duplicate -- never silently
    // overridden.
    const second = await commitScopeLineItems(version.id, document.id, [0]);
    expect(second.rowsImported).toBe(1);

    const lineItemCount = await db.lineItem.count({ where: { section: { estimateVersionId: version.id } } });
    expect(lineItemCount).toBe(2);
  });

  it("commits only the genuinely new item when a re-scan mixes one exact duplicate with one new item, with no explicit selection", async () => {
    const document = await makeAnalyzedDocument("some scope text");
    const firstBatch: ProposedLineItem[] = [
      {
        description: "Booth walls",
        qty: 1,
        qtyIsExplicit: true,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: firstBatch as unknown as Prisma.InputJsonValue },
    });
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    await commitScopeLineItems(version.id, document.id);

    // A re-scan (e.g. of a different, overlapping document) proposes the
    // same "Booth walls" item again alongside one genuinely new item.
    const secondBatch: ProposedLineItem[] = [
      { ...firstBatch[0] },
      {
        description: "Graphics production",
        qty: 1,
        qtyIsExplicit: true,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Countertops & Cable Management",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: secondBatch as unknown as Prisma.InputJsonValue },
    });

    const second = await commitScopeLineItems(version.id, document.id);
    expect(second.rowsImported).toBe(1);

    const items = await db.lineItem.findMany({ where: { section: { estimateVersionId: version.id } } });
    expect(items.map((i) => i.description).sort()).toEqual(["Booth walls", "Graphics production"]);
  });

  it("groups proposed items into sections by category, seeds a catalog-matched rate, and flags an inferred quantity in the description", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const document = await makeAnalyzedDocument("some scope text");

    const proposed: ProposedLineItem[] = [
      {
        description: "36 x 84 Compliant Door",
        qty: 2,
        qtyIsExplicit: true,
        unit: "EA",
        lineType: "MATERIAL",
        category: "Doors & Hardware",
        sourceQuote: "some scope text",
      },
      {
        description: "Installation labor",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "LABOR",
        category: "Labor & Installation",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });

    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitScopeLineItems(version.id, document.id);
    expect(result.sectionsCreated).toBe(2);
    expect(result.rowsImported).toBe(2);

    const sections = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    const allLineItems = sections.flatMap((s) => s.lineItems);
    expect(allLineItems).toHaveLength(2);
    expect(allLineItems.every((li) => li.isDraft)).toBe(true);

    const doorItem = allLineItems.find((li) => li.description.includes("Compliant Door"));
    expect(doorItem?.unitCost.toNumber()).toBe(150); // catalog-matched
    expect(doorItem?.description).not.toContain("qty estimated");

    const laborItem = allLineItems.find((li) => li.description.includes("Installation labor"));
    expect(laborItem?.unitCost.toNumber()).toBe(0); // no catalog match
    expect(laborItem?.description).toContain("(qty estimated -- verify)");

    // The check-and-balance: every committed row carries the exact quote
    // it came from, so a reviewer can click through and verify it -- for
    // a DOCX source there's no page concept, so sourcePageNumber stays
    // null and the viewer falls back to a text-search highlight instead.
    expect(allLineItems.every((li) => li.sourceQuote === "some scope text")).toBe(true);
    expect(allLineItems.every((li) => li.sourcePageNumber === null)).toBe(true);
  });

  it("resolves a SEG-worded item to Graphics even though the AI filed its whole scope bucket under Booth Structure & Walls", async () => {
    // Confirmed against real data: a real committed item ("SEG fabric for
    // wall systems") landed under Structure because mapScopeCategoryToCanonical
    // maps the AI's own "Booth Structure & Walls" bucket wholesale, before
    // the item's own description was ever checked -- same bug pattern as
    // design-cost-estimate-import-service.ts, fixed the same way here.
    await db.category.createMany({
      data: [
        { name: "Structure", key: "structure" },
        { name: "Graphics", key: "graphics" },
      ],
    });
    const document = await makeAnalyzedDocument("some scope text");
    const proposed: ProposedLineItem[] = [
      {
        description: "SEG fabric for wall systems",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
      {
        description: "Custom SEG structure resembling a golf tee",
        qty: 1,
        qtyIsExplicit: false,
        unit: "EA",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitScopeLineItems(version.id, document.id);

    const lineItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    const segFabric = lineItems.find((li) => li.description.includes("SEG fabric"));
    expect(segFabric?.category).toBe("Graphics");

    // "SEG" in any real phrasing means Graphics -- confirmed against 363
    // real production line items (see isAlwaysGraphicsDescription's own
    // comment) that this "golf tee" wording is also genuine SEG fabric,
    // not an unrelated internal reference as an earlier, narrower version
    // of this rule had assumed.
    const golfTee = lineItems.find((li) => li.description.includes("golf tee"));
    expect(golfTee?.category).toBe("Graphics");
  });

  it("uses a model-reported pageNumber directly when present, bypassing text-search page lookup -- the drawing-sourced case", async () => {
    // A DOCX-mime document (no PDF page text at all) proves this isn't
    // accidentally working via locateQuotePage -- drawing-line-item-
    // service.ts's items carry pageNumber but an empty sourceQuote (no
    // text layer to search), so this is the only way they get a page.
    const document = await makeAnalyzedDocument("some scope text");
    const proposed: ProposedLineItem[] = [
      {
        description: "Booth structure fabrication",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "",
        pageNumber: 3,
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitScopeLineItems(version.id, document.id);

    const lineItem = await db.lineItem.findFirstOrThrow({ where: { documentId: document.id } });
    expect(lineItem.sourcePageNumber).toBe(3);
  });

  it("computes a real page number for a PDF source, from the PDF's own per-page text", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { uploadDocument } = await import("@/lib/document-service");
    const { extractPdfPageTexts } = await import("@/lib/ai/text-extraction");

    const rfpDir = path.resolve(
      import.meta.dirname,
      "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build",
    );
    const bytes = await readFile(path.join(rfpDir, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));

    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const file = new File([bytes], "RFP.pdf", { type: "application/pdf" });
    const document = await uploadDocument(opportunity.id, { file, documentType: "SCOPE_OF_WORK" });

    // A real, known substring pulled from a specific real page -- proves
    // the lookup finds the ACTUAL page, not just any non-null number.
    const pages = await extractPdfPageTexts(bytes);
    const targetPageIndex = 3;
    const realQuote = pages[targetPageIndex].slice(40, 90).trim();
    expect(realQuote.length).toBeGreaterThan(20);

    await db.document.update({
      where: { id: document.id },
      data: { extractionStatus: "COMPLETE", extractedText: pages.join("\n") },
    });

    const proposed: ProposedLineItem[] = [
      {
        description: "Real scope item",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Other",
        sourceQuote: realQuote,
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });

    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    await commitScopeLineItems(version.id, document.id);

    const lineItem = await db.lineItem.findFirstOrThrow({ where: { documentId: document.id } });
    expect(lineItem.sourcePageNumber).toBe(targetPageIndex + 1);
    expect(lineItem.sourceQuote).toBe(realQuote);
  });

  it("constrains category to the fixed SCOPE_CATEGORIES list in the strict JSON schema sent to OpenAI", () => {
    // Proves the enum is actually wired into the request schema (strict:
    // true), not just documented in the type -- a category value outside
    // this list fails OpenAI's schema validation before it ever comes back.
    const schema = buildProposalSchema([]);
    expect(schema.strict).toBe(true);
    expect(schema.schema.properties.items.items.properties.category.enum).toEqual(SCOPE_CATEGORIES);
  });

  it("groups items into one section when two proposal runs land on the same fixed category, even with different descriptions", async () => {
    // The real bug this taxonomy fixes: two runs on the same document used
    // to produce differently-worded categories ('Doors and Hardware' vs.
    // 'Doors and Locks'), so a re-propose could never merge cleanly. With a
    // fixed enum, both runs land on the exact same string.
    const document = await makeAnalyzedDocument("some scope text");
    const proposed: ProposedLineItem[] = [
      {
        description: "36 x 84 Compliant Door",
        qty: 2,
        qtyIsExplicit: true,
        unit: "EA",
        lineType: "MATERIAL",
        category: "Doors & Hardware",
        sourceQuote: "some scope text",
      },
      {
        description: "Push-bar panic hardware",
        qty: 2,
        qtyIsExplicit: true,
        unit: "EA",
        lineType: "MATERIAL",
        category: "Doors & Hardware",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitScopeLineItems(version.id, document.id);
    expect(result.sectionsCreated).toBe(1);

    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id } });
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("Doors & Hardware");
  });

  it("rejects committing a document that belongs to a different opportunity than the target estimate", async () => {
    const document = await makeAnalyzedDocument("some scope text");
    const proposed: ProposedLineItem[] = [
      {
        description: "Booth walls",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });
    const otherEstimate = await db.estimate.create({ data: { opportunityId: otherOpportunity.id } });
    const otherVersion = await createEstimateVersion(otherEstimate.id, 0);

    await expect(commitScopeLineItems(otherVersion.id, document.id)).rejects.toThrow();

    const lineItemCount = await db.lineItem.count({ where: { section: { estimateVersionId: otherVersion.id } } });
    expect(lineItemCount).toBe(0);
  });

  it("stamps aiProposalSnapshot with aiFeature SCOPE_LINE_ITEMS for a scope-text document, DRAWING_LINE_ITEMS for a drawing", async () => {
    const scopeDocument = await makeAnalyzedDocument("some scope text");
    // Non-PDF mimeType, same reason makeAnalyzedDocument's own default
    // is a .docx -- commitScopeLineItems only fetches real storage bytes
    // (for PDF page-locating) when mimeType === PDF_MIME, and this test
    // has no real storage object behind its fake storageKey.
    const drawingDocument = await db.document.create({
      data: {
        opportunityId: scopeDocument.opportunityId,
        filename: "Floor Plan.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "DRAWING",
        extractionStatus: "COMPLETE",
      },
    });
    const proposedFor = (description: string): ProposedLineItem[] => [
      {
        description,
        qty: 1,
        qtyIsExplicit: true,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: scopeDocument.id },
      data: { proposedLineItems: proposedFor("Booth walls") as unknown as Prisma.InputJsonValue },
    });
    await db.document.update({
      where: { id: drawingDocument.id },
      data: { proposedLineItems: proposedFor("Countertop fabrication") as unknown as Prisma.InputJsonValue },
    });
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitScopeLineItems(version.id, scopeDocument.id);
    await commitScopeLineItems(version.id, drawingDocument.id);

    const scopeItem = await db.lineItem.findFirstOrThrow({ where: { description: "Booth walls" } });
    const drawingItem = await db.lineItem.findFirstOrThrow({ where: { description: "Countertop fabrication" } });
    expect((scopeItem.aiProposalSnapshot as { aiFeature: string }).aiFeature).toBe("SCOPE_LINE_ITEMS");
    expect((drawingItem.aiProposalSnapshot as { aiFeature: string }).aiFeature).toBe("DRAWING_LINE_ITEMS");
  });
});

describe("buildSystemPrompt", () => {
  // The real bug this guards against: the generic framing made a real
  // 73,764-character meeting transcript return zero items despite having
  // 16 real biddable items in it -- confirmed live, the transcript-aware
  // framing fixed it with nothing else changed. This test only proves the
  // branch is wired, not the AI outcome (that needs a real key).
  it("includes transcript-specific framing and noise-filtering guidance only when isTranscript is true", () => {
    const withTranscript = buildSystemPrompt([], true);
    const withoutTranscript = buildSystemPrompt([], false);

    expect(withTranscript).toMatch(/meeting transcript, recap, or email thread/);
    expect(withTranscript).toMatch(/estimating platform\/software itself/);
    expect(withoutTranscript).not.toMatch(/meeting transcript, recap, or email thread/);
    expect(withoutTranscript).not.toMatch(/estimating platform\/software itself/);
    expect(withoutTranscript).toMatch(/Scope of Work \/ RFP document/);
  });

  // Roadmap item #3, straight from a 15-year estimator's field feedback:
  // a paraphrased description silently drops the exact material/finish
  // spec a custom-build item's source wording carries (their own example:
  // "single-sided Chinese birch" flattened to a generic "plywood"). This
  // only proves the instruction is present in the prompt, not that the
  // model follows it -- that needs a real key and a real RFP.
  it("instructs the model to preserve source wording for custom-fabricated items", () => {
    const prompt = buildSystemPrompt([], false);
    expect(prompt).toMatch(/preserve the source's own specifying language/);
    expect(prompt).toMatch(/single-sided Chinese birch/);
  });
});

describe("flagUncertainClassifications", () => {
  const context: ProjectContext = {
    estimates: [
      { id: "estimate-a", name: "Project A" },
      { id: "estimate-b", name: "Project B" },
    ],
  };
  const baseItem: ProposedLineItem = {
    description: "Booth structure fabrication",
    qty: 1,
    qtyIsExplicit: false,
    unit: "LOT",
    lineType: "MATERIAL",
    category: "Booth Structure & Walls",
    sourceQuote: "some quote",
    estimateId: "estimate-a",
  };

  it("leaves an item unflagged when the second pass agrees with the first", () => {
    const result = flagUncertainClassifications(
      [baseItem],
      [{ description: "Booth structure fabrication", project: "Project A" }],
      context,
    );
    expect(result[0].classificationUncertain).toBeUndefined();
  });

  it("flags an item when the second pass resolves to a different estimate than the first", () => {
    const result = flagUncertainClassifications(
      [baseItem],
      [{ description: "Booth structure fabrication", project: "Project B" }],
      context,
    );
    expect(result[0].classificationUncertain).toBe(true);
    // First pass stays authoritative -- flagging never overrides estimateId.
    expect(result[0].estimateId).toBe("estimate-a");
  });

  it("flags an item when the second pass says SHARED but the first resolved to a specific project", () => {
    const result = flagUncertainClassifications(
      [baseItem],
      [{ description: "Booth structure fabrication", project: "SHARED" }],
      context,
    );
    expect(result[0].classificationUncertain).toBe(true);
  });

  it("leaves an item unflagged, not crashing, when it's missing from the second pass entirely", () => {
    const result = flagUncertainClassifications([baseItem], [], context);
    expect(result[0].classificationUncertain).toBeUndefined();
    expect(result[0].estimateId).toBe("estimate-a");
  });
});

describe("loadDuplicateCandidates", () => {
  // Real production incident: mergeBoothIntoAnotherBooth re-points every
  // merged child section's own groupLabel at its new H1 wrapper's id, so a
  // naive "is this section's groupLabel actually another section's id"
  // corruption check can't tell a merged child apart from genuinely
  // corrupted data -- both look identical. Nulling the groupKey either way
  // is safe in isolation, but once two sibling sheets under the same
  // merged booth share a generic description ("Mixed Hardware", "Shop
  // Supplies"), their candidates collapse into one ambiguous null-groupKey
  // pool and Tier 1 can no longer tell them apart -- confirmed live: a
  // re-import against an already-merged "Large Simulators" booth silently
  // recreated ~99 duplicate rows this way. mergeBoothIntoAnotherBooth
  // itself is what makes the fix possible: it always creates exactly one
  // new wrapper section per distinct source sheet, named after that
  // source's own resolved heading -- so that wrapper's own `name` is still
  // a real per-sheet key even once its `groupLabel` no longer is.
  it("recovers a real per-sheet groupKey from a merged child section's own name, instead of collapsing every sibling sheet's items into one null-groupKey pool", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const wrapper = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Large Simulators", sectionType: "COMPONENT" },
    });
    // Two sibling sheets merged into the same booth -- exactly the shape
    // mergeBoothIntoAnotherBooth produces: each sheet gets its own child
    // section, own real name, but a shared groupLabel pointing at the
    // wrapper.
    const sheetA = await db.estimateSection.create({
      data: {
        estimateVersionId: version.id,
        name: "04 Large Sim Front Left Structure",
        sectionType: "CATEGORY",
        groupLabel: wrapper.id,
        buildType: "RENTAL",
      },
    });
    const sheetB = await db.estimateSection.create({
      data: {
        estimateVersionId: version.id,
        name: "05 Large Sim Back Left Structure",
        sectionType: "CATEGORY",
        groupLabel: wrapper.id,
        buildType: "RENTAL",
      },
    });
    // Same generic description on both sheets -- the exact ambiguity that
    // broke Tier 1 in production.
    await db.lineItem.create({
      data: { sectionId: sheetA.id, lineType: "MATERIAL", description: "Mixed Hardware", qty: 100, unitCost: 1, totalCost: 100 },
    });
    await db.lineItem.create({
      data: { sectionId: sheetB.id, lineType: "MATERIAL", description: "Mixed Hardware", qty: 100, unitCost: 1, totalCost: 100 },
    });

    const candidates = await loadDuplicateCandidates(version.id);
    expect(candidates).toHaveLength(2);
    const [candidateA, candidateB] = candidates;

    // Neither collapses to null...
    expect(candidateA.groupKey).not.toBeNull();
    expect(candidateB.groupKey).not.toBeNull();
    // ...and each recovers its own sheet's real name, not the shared wrapper id.
    expect(candidateA.groupKey).toBe("04 Large Sim Front Left Structure");
    expect(candidateB.groupKey).toBe("05 Large Sim Back Left Structure");

    // End-to-end: a fresh import row for sheet B's own "Mixed Hardware"
    // must match sheet B's existing candidate specifically, not bounce off
    // an ambiguous match against both siblings (which is what null
    // groupKeys on both sides would have produced) and get silently
    // re-created as a third, duplicate row.
    const proposedForSheetB: ProposedItemForDuplicateCheck[] = [
      { description: "Mixed Hardware", qty: 100, unit: null, groupKey: "05 Large Sim Back Left Structure" },
    ];
    const matches = findExactDuplicates(proposedForSheetB, candidates);
    expect(matches.get(0)?.id).toBe(candidateB.id);
  });

  it("still uses the raw groupLabel directly for a standalone (never-merged) section, unchanged from before", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const section = await db.estimateSection.create({
      data: {
        estimateVersionId: version.id,
        name: "Structure",
        sectionType: "CATEGORY",
        groupLabel: "20 Netting Hard Support Large Front Left",
      },
    });
    await db.lineItem.create({
      data: { sectionId: section.id, lineType: "MATERIAL", description: "Mixed Hardware", qty: 200, unitCost: 1, totalCost: 200 },
    });

    const [candidate] = await loadDuplicateCandidates(version.id);
    expect(candidate.groupKey).toBe("20 Netting Hard Support Large Front Left");
  });
});
