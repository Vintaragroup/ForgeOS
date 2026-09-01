import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { addLineItem, addSection, createEstimateVersion } from "@/lib/estimate-service";
import type { ProposedLineItem } from "@/lib/ai/scope-line-item-service";
import { findMisattributedLineItems } from "@/lib/line-item-audit-service";

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeTwoNamedEstimates() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const estimateA = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Estimate A" } });
  const estimateB = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Estimate B" } });
  const versionA = await createEstimateVersion(estimateA.id, 0);
  const versionB = await createEstimateVersion(estimateB.id, 0);
  return { opportunity, estimateA, estimateB, versionA, versionB };
}

async function makeDocument(opportunityId: string, data: { estimateId?: string | null; proposedLineItems?: ProposedLineItem[] | null } = {}) {
  return db.document.create({
    data: {
      opportunityId,
      filename: "Scope of Work.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "SCOPE_OF_WORK",
      extractionStatus: "COMPLETE",
      estimateId: data.estimateId ?? null,
      proposedLineItems: (data.proposedLineItems ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
    },
  });
}

describe("findMisattributedLineItems", () => {
  it("returns nothing for a single-NAMED-estimate opportunity, even with a document tagged to a second (unnamed) estimate", async () => {
    // Only 1 NAMED estimate -- getProjectContext (scope-document-context.ts)
    // requires 2+ before multi-project logic activates at all, regardless
    // of how many total Estimate rows exist or how documents are tagged.
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Only estimate" } });
    const unnamedEstimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Other", sectionType: "CATEGORY" });
    const doc = await makeDocument(opportunity.id, { estimateId: unnamedEstimate.id });
    const item = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Item", qty: 1, unitCost: 1 });
    await db.lineItem.update({ where: { id: item.id }, data: { documentId: doc.id } });

    const findings = await findMisattributedLineItems(opportunity.id);
    expect(findings).toEqual([]);
  });

  it("flags a line item whose source document is tagged to a DIFFERENT estimate than where it's committed", async () => {
    const { opportunity, estimateA, estimateB, versionB } = await makeTwoNamedEstimates();
    const doc = await makeDocument(opportunity.id, { estimateId: estimateA.id });
    const sectionB = await addSection(versionB.id, { name: "Other", sectionType: "CATEGORY" });
    const item = await addLineItem(versionB.id, sectionB.id, { lineType: "MATERIAL", description: "Batting cage", qty: 1, unitCost: 1 });
    await db.lineItem.update({ where: { id: item.id }, data: { documentId: doc.id, sourceQuote: "quote" } });

    const findings = await findMisattributedLineItems(opportunity.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      lineItemId: item.id,
      currentEstimateId: estimateB.id,
      correctEstimateId: estimateA.id,
      reason: "document-tag-mismatch",
    });
  });

  it("does not flag a line item whose source document tag matches where it's committed", async () => {
    const { opportunity, estimateA, versionA } = await makeTwoNamedEstimates();
    const doc = await makeDocument(opportunity.id, { estimateId: estimateA.id });
    const sectionA = await addSection(versionA.id, { name: "Other", sectionType: "CATEGORY" });
    const item = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Batting cage", qty: 1, unitCost: 1 });
    await db.lineItem.update({ where: { id: item.id }, data: { documentId: doc.id } });

    const findings = await findMisattributedLineItems(opportunity.id);
    expect(findings).toEqual([]);
  });

  it("flags a shared/untagged document's item whose cached AI classification disagrees with where it landed", async () => {
    const { opportunity, estimateA, estimateB, versionB } = await makeTwoNamedEstimates();
    const proposed: ProposedLineItem[] = [
      {
        description: "Palm trees rental",
        qty: 5,
        qtyIsExplicit: true,
        unit: "EA",
        lineType: "MATERIAL",
        category: "Other",
        sourceQuote: "five palm trees",
        estimateId: estimateA.id,
      },
    ];
    const doc = await makeDocument(opportunity.id, { estimateId: null, proposedLineItems: proposed });
    const sectionB = await addSection(versionB.id, { name: "Other", sectionType: "CATEGORY" });
    const item = await addLineItem(versionB.id, sectionB.id, { lineType: "MATERIAL", description: "Palm trees rental", qty: 5, unitCost: 1 });
    await db.lineItem.update({ where: { id: item.id }, data: { documentId: doc.id, sourceQuote: "five palm trees" } });

    const findings = await findMisattributedLineItems(opportunity.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      lineItemId: item.id,
      currentEstimateId: estimateB.id,
      correctEstimateId: estimateA.id,
      reason: "ai-classification-mismatch",
    });
  });

  it("does not flag a manually-added line item with no documentId -- no signal to check it against", async () => {
    const { opportunity, versionA } = await makeTwoNamedEstimates();
    const sectionA = await addSection(versionA.id, { name: "Other", sectionType: "CATEGORY" });
    await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Manually added item", qty: 1, unitCost: 1 });

    const findings = await findMisattributedLineItems(opportunity.id);
    expect(findings).toEqual([]);
  });

  it("does not flag an item from a shared document whose cache was cleared (e.g. by a later retag) -- can't verify, so no false clearance either", async () => {
    const { opportunity, versionB } = await makeTwoNamedEstimates();
    const doc = await makeDocument(opportunity.id, { estimateId: null, proposedLineItems: null });
    const sectionB = await addSection(versionB.id, { name: "Other", sectionType: "CATEGORY" });
    const item = await addLineItem(versionB.id, sectionB.id, { lineType: "MATERIAL", description: "Some item", qty: 1, unitCost: 1 });
    await db.lineItem.update({ where: { id: item.id }, data: { documentId: doc.id, sourceQuote: "quote" } });

    const findings = await findMisattributedLineItems(opportunity.id);
    expect(findings).toEqual([]);
  });
});
