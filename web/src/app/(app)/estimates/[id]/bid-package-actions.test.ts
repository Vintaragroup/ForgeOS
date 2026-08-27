import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { addLineItem, addSection, createBidPackage, createEstimateVersion } from "@/lib/estimate-service";
import { resetMockCookies } from "@/test/setup";
import {
  applyVendorMatchAction,
  attachVendorQuoteDocumentAction,
  createBidPackageAction,
  markBidPackageReviewedAction,
  proposeVendorQuoteItemsAction,
  removeLineItemFromBidPackageAction,
} from "./bid-package-actions";

beforeEach(() => {
  resetMockCookies();
});

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.document.deleteMany();
  await db.bidPackage.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeAdmin() {
  return db.user.create({ data: { name: "Admin", email: `${Math.random()}@test.com`, systemRole: "ADMIN" } });
}

async function makeEstimateWithLineItem() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 0);
  const section = await addSection(version.id, { name: "Flooring", sectionType: "CATEGORY" });
  const item = await addLineItem(version.id, section.id, {
    lineType: "MATERIAL",
    description: "Sleeper Floor Required",
    qty: 1,
    unitCost: 0,
    isDraft: true,
  });
  return { opportunity, estimate, version, section, item };
}

describe("createBidPackageAction", () => {
  it("rejects an unauthenticated caller", async () => {
    const { estimate, version, item } = await makeEstimateWithLineItem();

    await expect(
      createBidPackageAction(estimate.id, version.id, { name: "Package", lineItemIds: [item.id] }),
    ).rejects.toThrow(/access|authenticated/i);
  });

  it("creates a bid package and assigns the selected line items", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();

    await createBidPackageAction(estimate.id, version.id, {
      name: "Scaffolding, Platforms & Truss",
      vendorName: "ShowRig",
      lineItemIds: [item.id],
    });

    const bidPackage = await db.bidPackage.findFirstOrThrow({ where: { estimateVersionId: version.id } });
    expect(bidPackage.name).toBe("Scaffolding, Platforms & Truss");
    expect(bidPackage.vendorName).toBe("ShowRig");
    const updatedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updatedItem.bidPackageId).toBe(bidPackage.id);
  });
});

describe("applyVendorMatchAction", () => {
  it("applies a vendor price onto the line item chosen in the form, stamps provenance, and updates version totals", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
      },
    });

    const formData = new FormData();
    formData.set("lineItemId", item.id);
    formData.set("unitCost", "840");
    formData.set("documentId", document.id);
    formData.set("sourceQuote", "Sleeper Floor");
    await applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData);

    const updatedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updatedItem.unitCost.toNumber()).toBe(840);
    expect(updatedItem.totalCost.toNumber()).toBe(840);
    expect(updatedItem.documentId).toBe(document.id);
    expect(updatedItem.isDraft).toBe(false);

    const updatedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(updatedVersion.totalCost.toNumber()).toBe(840);
  });

  it("rejects a lineItemId that doesn't belong to this bid package", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    // A second, unrelated line item that was never added to this package.
    const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const outsideItem = await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Unrelated item",
      qty: 1,
      unitCost: 0,
    });

    const formData = new FormData();
    formData.set("lineItemId", outsideItem.id);
    formData.set("unitCost", "840");
    formData.set("documentId", "doc-1");
    await expect(applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow();

    const stillZero = await db.lineItem.findUniqueOrThrow({ where: { id: outsideItem.id } });
    expect(stillZero.unitCost.toNumber()).toBe(0);
  });

  it("rejects a missing lineItemId", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });

    const formData = new FormData();
    formData.set("unitCost", "840");
    formData.set("documentId", "doc-1");
    await expect(applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      "Choose which line item",
    );
  });

  it("rejects a non-numeric unit cost", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });

    const formData = new FormData();
    formData.set("lineItemId", item.id);
    formData.set("unitCost", "not a number");
    formData.set("documentId", "doc-1");
    await expect(applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      "Unit cost must be a number",
    );
  });
});

describe("proposeVendorQuoteItemsAction", () => {
  it("rejects a documentId that belongs to a DIFFERENT bid package", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    // A VENDOR_QUOTE document that exists in the same Opportunity but was
    // never attached to this package (bidPackageId stays null).
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "Unrelated quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
      },
    });

    await expect(proposeVendorQuoteItemsAction(estimate.id, bidPackage.id, document.id)).rejects.toThrow();
  });

  it("surfaces a clear error when AI isn't configured -- .env.test deliberately has no OPENAI_API_KEY", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
        extractionStatus: "COMPLETE",
        extractedText: "CAM-06 Sleeper Floor $840.00",
        bidPackageId: bidPackage.id,
      },
    });

    await expect(proposeVendorQuoteItemsAction(estimate.id, bidPackage.id, document.id)).rejects.toThrow(
      "AI features aren't configured yet",
    );
  });
});

describe("removeLineItemFromBidPackageAction", () => {
  it("clears a line item's bid-package assignment", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });

    await removeLineItemFromBidPackageAction(estimate.id, item.id);

    const updated = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.bidPackageId).toBeNull();
  });
});

describe("markBidPackageReviewedAction", () => {
  it("marks a bid package as reviewed", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { version, item } = await makeEstimateWithLineItem();
    const estimate = await db.estimate.findFirstOrThrow({ where: { versions: { some: { id: version.id } } } });
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });

    await markBidPackageReviewedAction(estimate.id, bidPackage.id);

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    expect(updated.status).toBe("REVIEWED");
  });
});

describe("attachVendorQuoteDocumentAction", () => {
  it("attaches an uploaded vendor quote document to a bid package", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
      },
    });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await attachVendorQuoteDocumentAction(estimate.id, bidPackage.id, formData);

    const updated = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.bidPackageId).toBe(bidPackage.id);
  });
});
