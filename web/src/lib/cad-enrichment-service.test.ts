import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import { previewPullSheetEnrichment, applyPullSheetEnrichment } from "@/lib/cad-enrichment-service";

// Same real, matching CAD/Excel pair used by cad-reconciliation-service.test.ts
// -- BM1's Part Number ("606 0310 0434") and Size ("310mm x 434mm") were
// independently confirmed live against both documents earlier this session.
const CAD_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/CAD-files/SUPER BOWL A 6.3.0 SECTION 203.pdf",
);

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeCadDocument(opportunityId: string, filename: string) {
  const bytes = await readFile(CAD_PATH);
  const file = new File([bytes], filename, { type: "application/pdf" });
  return uploadDocument(opportunityId, { file, documentType: "DRAWING" });
}

async function makeEstimateWithSection(opportunityId: string) {
  const estimate = await db.estimate.create({ data: { opportunityId } });
  const version = await createEstimateVersion(estimate.id, 0);
  const section = await db.estimateSection.create({
    data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY", sortOrder: 0 },
  });
  return { estimate, version, section };
}

describe("previewPullSheetEnrichment / applyPullSheetEnrichment", () => {
  it("proposes appending the CAD's real dimension to a terse Excel-derived description, matched by Part Number", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const cadDoc = await makeCadDocument(opportunity.id, "SUPER BOWL A 6.3.0 SECTION 203.pdf");
    const excelDoc = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "SUPER BOWL A 6.3.0 SECTION 203.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "PRICING_SCHEDULE",
      },
    });
    const { version, section } = await makeEstimateWithSection(opportunity.id);
    const lineItem = await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "1/3M X 1/2M FRAME",
        qty: 1,
        unitCost: 195,
        totalCost: 195,
        documentId: excelDoc.id,
        positionCode: "606 0310 0434",
      },
    });

    const preview = await previewPullSheetEnrichment(version.id, cadDoc.id);
    if ("status" in preview) throw new Error(`Expected a real preview, got ${preview.reason}`);
    expect(preview.proposals).toEqual([
      {
        lineItemId: lineItem.id,
        currentDescription: "1/3M X 1/2M FRAME",
        proposedDescription: "1/3M X 1/2M FRAME (310mm x 434mm)",
        partNumber: "606 0310 0434",
        cadSize: "310mm x 434mm",
      },
    ]);

    const result = await applyPullSheetEnrichment(opportunity.id, version.id, cadDoc.id);
    expect(result).toEqual({ updated: 1 });
    const updated = await db.lineItem.findUniqueOrThrow({ where: { id: lineItem.id } });
    expect(updated.description).toBe("1/3M X 1/2M FRAME (310mm x 434mm)");
    // Description-only change -- cost untouched.
    expect(updated.unitCost.toNumber()).toBe(195);
  });

  it("proposes nothing when the description already contains the CAD's dimension", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const cadDoc = await makeCadDocument(opportunity.id, "SUPER BOWL A 6.3.0 SECTION 203.pdf");
    const excelDoc = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "SUPER BOWL A 6.3.0 SECTION 203.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "PRICING_SCHEDULE",
      },
    });
    const { version, section } = await makeEstimateWithSection(opportunity.id);
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "1/3M X 1/2M FRAME (310mm x 434mm)",
        qty: 1,
        unitCost: 195,
        totalCost: 195,
        documentId: excelDoc.id,
        positionCode: "606 0310 0434",
      },
    });

    const preview = await previewPullSheetEnrichment(version.id, cadDoc.id);
    if ("status" in preview) throw new Error(`Expected a real preview, got ${preview.reason}`);
    expect(preview.proposals).toHaveLength(0);
    expect(preview.alreadyComplete).toBe(1);
  });

  it("never enriches a line item sourced from a different booth's Excel, even if a Part Number coincidentally matches", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const cadDoc = await makeCadDocument(opportunity.id, "SUPER BOWL A 6.3.0 SECTION 203.pdf");
    // A different booth's own Excel -- filename stem does NOT match the CAD's.
    const otherExcelDoc = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "SUPER BOWL A 6.3.0 SECTION 211.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key-other",
        documentType: "PRICING_SCHEDULE",
      },
    });
    const { version, section } = await makeEstimateWithSection(opportunity.id);
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "1/3M X 1/2M FRAME",
        qty: 1,
        unitCost: 195,
        totalCost: 195,
        documentId: otherExcelDoc.id,
        positionCode: "606 0310 0434",
      },
    });

    const preview = await previewPullSheetEnrichment(version.id, cadDoc.id);
    if ("status" in preview) throw new Error(`Expected a real preview, got ${preview.reason}`);
    expect(preview.proposals).toHaveLength(0);
    expect(preview.noCadMatch).toBe(0);
    expect(preview.alreadyComplete).toBe(0);
  });
});
