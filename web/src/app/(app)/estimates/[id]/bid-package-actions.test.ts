import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { addLineItem, addSection, createBidPackage, createEstimateVersion } from "@/lib/estimate-service";
import { resetMockCookies } from "@/test/setup";
import type { ProposedVendorSection, VendorLineMatch, VendorQuoteLine } from "@/lib/ai/vendor-match-ai-service";
import {
  applyAllHighConfidenceMatchesAction,
  applySelectedVendorMatchesAction,
  applyVendorMatchAction,
  applyVendorMatchGroupAction,
  attachVendorQuoteDocumentAction,
  commitProposedVendorSectionAction,
  createBidPackageAction,
  dismissProposedVendorSectionAction,
  getBidPackageExtractionStatusAction,
  markBidPackageReviewedAction,
  proposeVendorQuoteItemsAction,
  removeLineItemFromBidPackageAction,
} from "./bid-package-actions";

function vendorLine(description: string, unitPrice: number, qty: number | null = 1): VendorQuoteLine {
  return { description, unit: "EA", qty, unitPrice, totalPrice: unitPrice, sourceQuote: description, unitCode: "One Time Service Costs", pageNumber: 1 };
}

// A successful Apply/Re-apply now redirects to flash a "✓ Applied"
// confirmation (see applyVendorMatchAction's own comment on why) --
// Next.js implements redirect() by throwing, so the success path is
// asserted by catching that throw and checking its digest carries the
// expected lineItemId, rather than awaiting a normal return.
async function expectAppliedRedirect(promise: Promise<unknown>, lineItemId: string) {
  await expect(promise).rejects.toMatchObject({
    digest: expect.stringContaining(`applied=${encodeURIComponent(lineItemId)}`),
  });
}

function match(vendorLine: VendorQuoteLine, overrides: Partial<VendorLineMatch> = {}): VendorLineMatch {
  return {
    vendorLine,
    lineItemId: null,
    confidence: "low",
    reasoning: "No candidate matches.",
    needsClarification: true,
    suggestedLineItemId: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetMockCookies();
});

afterEach(async () => {
  await db.vendorMatchApplyLog.deleteMany();
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
    await expectAppliedRedirect(applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData), item.id);

    const updatedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updatedItem.unitCost.toNumber()).toBe(840);
    expect(updatedItem.totalCost.toNumber()).toBe(840);
    expect(updatedItem.documentId).toBe(document.id);
    expect(updatedItem.isDraft).toBe(false);

    const updatedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(updatedVersion.totalCost.toNumber()).toBe(840);
  });

  it("accumulates the applied flash across two applies instead of the second clobbering the first -- reproduces a live report where the first row's \"Applied\" badge disappeared", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const secondItem = await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Second item",
      qty: 1,
      unitCost: 0,
    });
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

    const firstFormData = new FormData();
    firstFormData.set("lineItemId", item.id);
    firstFormData.set("unitCost", "840");
    firstFormData.set("documentId", document.id);
    // No priorApplied -- this is the first apply this session, same as
    // the page renders an empty hidden field when appliedLineItemIds is
    // still empty.
    let firstDigest = "";
    try {
      await applyVendorMatchAction(estimate.id, version.id, bidPackage.id, firstFormData);
    } catch (err) {
      firstDigest = (err as { digest?: string }).digest ?? "";
    }
    expect(firstDigest).toContain(`applied=${encodeURIComponent(item.id)}`);

    // Second apply carries the FIRST id forward via priorApplied, the
    // same way the page renders it back into the next form's hidden
    // field from the URL the first redirect just produced.
    const secondFormData = new FormData();
    secondFormData.set("lineItemId", secondItem.id);
    secondFormData.set("unitCost", "500");
    secondFormData.set("documentId", document.id);
    secondFormData.set("priorApplied", item.id);
    await expect(
      applyVendorMatchAction(estimate.id, version.id, bidPackage.id, secondFormData),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(
        `applied=${encodeURIComponent(`${item.id},${secondItem.id}`)}`,
      ),
    });

    // Both rows' own data is independently correct -- the accumulator is
    // purely a display concern, never a data one.
    const updatedFirst = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    const updatedSecond = await db.lineItem.findUniqueOrThrow({ where: { id: secondItem.id } });
    expect(updatedFirst.unitCost.toNumber()).toBe(840);
    expect(updatedSecond.unitCost.toNumber()).toBe(500);
  });

  it("applies a vendor price to a line item NOT yet in this bid package, and adds it to the package -- the candidate pool is now version-wide, not package-scoped", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    // A second line item on the same version, never added to this package.
    const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const outsideItem = await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Unrelated item",
      qty: 1,
      unitCost: 0,
    });
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
    formData.set("lineItemId", outsideItem.id);
    formData.set("unitCost", "840");
    formData.set("documentId", document.id);
    await expectAppliedRedirect(
      applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData),
      outsideItem.id,
    );

    const updated = await db.lineItem.findUniqueOrThrow({ where: { id: outsideItem.id } });
    expect(updated.unitCost.toNumber()).toBe(840);
    expect(updated.bidPackageId).toBe(bidPackage.id);
  });

  it("rejects a lineItemId from a DIFFERENT estimate version", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    // A line item on a completely different estimate/version.
    const other = await makeEstimateWithLineItem();
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
    formData.set("lineItemId", other.item.id);
    formData.set("unitCost", "840");
    formData.set("documentId", document.id);
    await expect(applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow();

    const stillZero = await db.lineItem.findUniqueOrThrow({ where: { id: other.item.id } });
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

  it("records a durable audit log row for the apply, snapshotting who/what/when", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "ShowRig Package", lineItemIds: [item.id] });
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
    await expectAppliedRedirect(applyVendorMatchAction(estimate.id, version.id, bidPackage.id, formData), item.id);

    const logs = await db.vendorMatchApplyLog.findMany({ where: { estimateVersionId: version.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "single",
      actorId: admin.id,
      bidPackageId: bidPackage.id,
      bidPackageName: "ShowRig Package",
      lineItemId: item.id,
      targetDescription: "Sleeper Floor Required",
      documentId: document.id,
      documentFilename: "ShowRig quote.pdf",
    });
    expect(logs[0].unitCost.toNumber()).toBe(840);
    expect(logs[0].vendorLineDescriptions).toContain("Sleeper Floor");
  });
});

describe("applyVendorMatchGroupAction", () => {
  async function makePackageWithGroupedMatches() {
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
        bidPackageId: bidPackage.id,
      },
    });
    // Two vendor lines the AI's dedup logic already tied to the same
    // candidate (item.id) -- index 0 "won" (lineItemId set), index 1
    // "lost" (lineItemId nulled, suggestedLineItemId retained). A third,
    // unrelated vendor line with no shared target at all.
    const matches: VendorLineMatch[] = [
      match(vendorLine("Non Slip Paint [CAM-01]", 450, 1), {
        lineItemId: item.id,
        suggestedLineItemId: item.id,
        confidence: "medium",
        reasoning: "Non Slip Paint matches 'Slip-resistant flooring'.",
        needsClarification: false,
      }),
      match(vendorLine("Non Slip Paint [CAM-02]", 450, 1), {
        lineItemId: null,
        suggestedLineItemId: item.id,
        confidence: "low",
        reasoning: "Non Slip Paint matches 'Slip-resistant flooring'.",
        needsClarification: false,
      }),
      match(vendorLine("Soft Goods [CAM-03]", 800, 1), {
        lineItemId: null,
        suggestedLineItemId: null,
        confidence: "low",
        reasoning: "Soft Goods has no clear match.",
        needsClarification: false,
      }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });
    return { admin, estimate, version, item, bidPackage, document };
  }

  it("sums qty/price across the group onto the target line item and patches matchResult", async () => {
    const { estimate, version, item, bidPackage, document } = await makePackageWithGroupedMatches();

    const formData = new FormData();
    formData.set("lineItemId", item.id);
    formData.set("matchIndices", "0,1");
    formData.set("documentId", document.id);
    await expectAppliedRedirect(
      applyVendorMatchGroupAction(estimate.id, version.id, bidPackage.id, formData),
      item.id,
    );

    const updatedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updatedItem.qty.toNumber()).toBe(2);
    expect(updatedItem.unitCost.toNumber()).toBe(450);
    expect(updatedItem.totalCost.toNumber()).toBe(900);
    expect(updatedItem.documentId).toBe(document.id);
    expect(updatedItem.isDraft).toBe(false);
    expect(updatedItem.bidPackageId).toBe(bidPackage.id);

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    expect(updatedMatches[0].lineItemId).toBe(item.id);
    expect(updatedMatches[0].confidence).toBe("high");
    expect(updatedMatches[1].lineItemId).toBe(item.id);
    expect(updatedMatches[1].confidence).toBe("high");
    // Unrelated third match untouched.
    expect(updatedMatches[2].lineItemId).toBeNull();

    const updatedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(updatedVersion.totalCost.toNumber()).toBe(900);
  });

  it("records one audit log row for the whole group, listing both contributing vendor lines", async () => {
    const { admin, estimate, version, item, bidPackage, document } = await makePackageWithGroupedMatches();

    const formData = new FormData();
    formData.set("lineItemId", item.id);
    formData.set("matchIndices", "0,1");
    formData.set("documentId", document.id);
    await expectAppliedRedirect(applyVendorMatchGroupAction(estimate.id, version.id, bidPackage.id, formData), item.id);

    const logs = await db.vendorMatchApplyLog.findMany({ where: { estimateVersionId: version.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "group",
      actorId: admin.id,
      lineItemId: item.id,
      confidence: "high",
      vendorLineCount: 2,
    });
    expect(logs[0].vendorLineDescriptions).toBe("Non Slip Paint [CAM-01] | Non Slip Paint [CAM-02]");
    expect(logs[0].totalCost.toNumber()).toBe(900);
  });

  it("rejects a matchIndices entry that doesn't actually share the claimed target", async () => {
    const { estimate, version, item, bidPackage, document } = await makePackageWithGroupedMatches();

    const formData = new FormData();
    formData.set("lineItemId", item.id);
    // Index 2 targets nothing (suggestedLineItemId null) -- once dropped,
    // only index 0 is left, below the 2-line minimum.
    formData.set("matchIndices", "0,2");
    formData.set("documentId", document.id);
    await expect(applyVendorMatchGroupAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      "no longer available",
    );

    const unchanged = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.unitCost.toNumber()).toBe(0);
  });

  it("rejects fewer than two matchIndices", async () => {
    const { estimate, version, item, bidPackage, document } = await makePackageWithGroupedMatches();

    const formData = new FormData();
    formData.set("lineItemId", item.id);
    formData.set("matchIndices", "0");
    formData.set("documentId", document.id);
    await expect(applyVendorMatchGroupAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      "Select at least two",
    );
  });
});

describe("applyAllHighConfidenceMatchesAction", () => {
  it("applies every high-confidence match and leaves medium/low ones untouched", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const secondItem = await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Second item",
      qty: 1,
      unitCost: 0,
    });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
        bidPackageId: bidPackage.id,
      },
    });

    const matches: VendorLineMatch[] = [
      match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" }),
      match(vendorLine("Second Item Charge", 500), { lineItemId: secondItem.id, confidence: "high" }),
      match(vendorLine("Soft Goods", 800), { confidence: "low" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await expect(
      applyAllHighConfidenceMatchesAction(estimate.id, version.id, bidPackage.id, formData),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(`applied=${encodeURIComponent(`${item.id},${secondItem.id}`)}`),
    });

    const updatedFirst = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    const updatedSecond = await db.lineItem.findUniqueOrThrow({ where: { id: secondItem.id } });
    expect(updatedFirst.unitCost.toNumber()).toBe(840);
    expect(updatedFirst.isDraft).toBe(false);
    expect(updatedSecond.unitCost.toNumber()).toBe(500);

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    // The low-confidence, unmatched third row is completely untouched.
    expect(updatedMatches[2].lineItemId).toBeNull();
    expect(updatedMatches[2].confidence).toBe("low");

    const updatedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(updatedVersion.totalCost.toNumber()).toBe(1340);
  });

  it("records one audit log row per applied target -- not one for the low-confidence row that was skipped", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const secondItem = await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Second item",
      qty: 1,
      unitCost: 0,
    });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
        bidPackageId: bidPackage.id,
      },
    });
    const matches: VendorLineMatch[] = [
      match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" }),
      match(vendorLine("Second Item Charge", 500), { lineItemId: secondItem.id, confidence: "high" }),
      match(vendorLine("Soft Goods", 800), { confidence: "low" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await expect(applyAllHighConfidenceMatchesAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow();

    const logs = await db.vendorMatchApplyLog.findMany({ where: { estimateVersionId: version.id } });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.method === "all_high_confidence" && l.actorId === admin.id)).toBe(true);
    expect(logs.map((l) => l.lineItemId).sort()).toEqual([item.id, secondItem.id].sort());
  });

  it("only re-touches the still-pending target when one high-confidence match is already applied for this document -- doesn't re-write or re-log the one that's already done", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const secondItem = await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Second item",
      qty: 1,
      unitCost: 0,
    });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
        bidPackageId: bidPackage.id,
      },
    });
    // item is already applied for THIS document (documentId matches);
    // secondItem is still pending.
    await db.lineItem.update({ where: { id: item.id }, data: { documentId: document.id, unitCost: 840, isDraft: false } });
    const matches: VendorLineMatch[] = [
      match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" }),
      match(vendorLine("Second Item Charge", 500), { lineItemId: secondItem.id, confidence: "high" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await expect(
      applyAllHighConfidenceMatchesAction(estimate.id, version.id, bidPackage.id, formData),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(`applied=${encodeURIComponent(secondItem.id)}`),
    });

    // Only ONE audit log row -- the already-applied target was never
    // re-touched, so it was never re-logged either.
    const logs = await db.vendorMatchApplyLog.findMany({ where: { estimateVersionId: version.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].lineItemId).toBe(secondItem.id);
  });

  it("falls back to re-applying the full set when nothing is pending -- 'Re-apply all' means re-affirm everything, on purpose", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });
    await db.lineItem.update({ where: { id: item.id }, data: { documentId: document.id, unitCost: 840, isDraft: false } });
    const matches: VendorLineMatch[] = [
      match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await expectAppliedRedirect(
      applyAllHighConfidenceMatchesAction(estimate.id, version.id, bidPackage.id, formData),
      item.id,
    );

    const logs = await db.vendorMatchApplyLog.findMany({ where: { estimateVersionId: version.id } });
    expect(logs).toHaveLength(1);
  });

  it("rejects when there are no high-confidence matches", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });
    const matches: VendorLineMatch[] = [match(vendorLine("Soft Goods", 800), { confidence: "low" })];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await expect(applyAllHighConfidenceMatchesAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      "No high-confidence matches",
    );
  });

  it("self-heals a match pointing at a deleted line item -- applies the still-valid targets, clears the stale one, downgrades it to low confidence, and reports stale=1", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });

    // Reproduces the live production bug: matchResult's stored
    // lineItemId references a LineItem that was deleted via the Line
    // Items tab after the match was made, leaving a dangling reference
    // the app never scans/cleans up.
    const deletedTargetId = "deleted-line-item-does-not-exist";
    const matches: VendorLineMatch[] = [
      match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" }),
      match(vendorLine("Trucking", 25000), {
        lineItemId: deletedTargetId,
        suggestedLineItemId: deletedTargetId,
        confidence: "high",
      }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await expect(
      applyAllHighConfidenceMatchesAction(estimate.id, version.id, bidPackage.id, formData),
    ).rejects.toMatchObject({
      digest: expect.stringMatching(
        new RegExp(`applied=${item.id}.*stale=1|stale=1.*applied=${item.id}`),
      ),
    });

    const updatedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updatedItem.unitCost.toNumber()).toBe(840);

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    expect(updatedMatches[1].lineItemId).toBeNull();
    expect(updatedMatches[1].suggestedLineItemId).toBeNull();
    expect(updatedMatches[1].confidence).toBe("low");
    expect(updatedMatches[1].reasoning).toMatch(/no longer exists/i);

    // The valid target's total (840) is on the version; the stale
    // target's $25,000 was never silently written anywhere.
    const updatedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(updatedVersion.totalCost.toNumber()).toBe(840);
  });

  it("rejects with an explanatory message when every high-confidence match points at a deleted line item", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });
    const deletedTargetId = "deleted-line-item-does-not-exist";
    const matches: VendorLineMatch[] = [
      match(vendorLine("Trucking", 25000), { lineItemId: deletedTargetId, confidence: "high" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const formData = new FormData();
    formData.set("documentId", document.id);
    await expect(applyAllHighConfidenceMatchesAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      /no longer exist/i,
    );

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    // Even on the throw-because-nothing-applied path, the stale entry is
    // still self-healed in matchResult -- a reviewer reloading the page
    // sees an honest "no match" row instead of the misleading stale one.
    expect(updatedMatches[0].lineItemId).toBeNull();
    expect(updatedMatches[0].confidence).toBe("low");
  });
});

describe("applySelectedVendorMatchesAction", () => {
  it("applies exactly the checked subset and leaves unchecked rows -- of any confidence -- untouched", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const secondItem = await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Second item",
      qty: 1,
      unitCost: 0,
    });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
        bidPackageId: bidPackage.id,
      },
    });

    const matches: VendorLineMatch[] = [
      match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" }),
      // Only a suggestion, never a resolved lineItemId -- exactly the
      // "medium/low confidence" case applyAllHighConfidenceMatchesAction
      // can never reach, and the whole point of letting a reviewer
      // hand-pick which suggestions to trust.
      match(vendorLine("Second Item Charge", 500), { suggestedLineItemId: secondItem.id, confidence: "medium" }),
      match(vendorLine("Soft Goods", 800), { confidence: "low" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const result = await applySelectedVendorMatchesAction(estimate.id, version.id, bidPackage.id, document.id, [0, 1]);

    expect(result.staleCount).toBe(0);
    expect(result.appliedLineItemIds.sort()).toEqual([item.id, secondItem.id].sort());

    const updatedFirst = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    const updatedSecond = await db.lineItem.findUniqueOrThrow({ where: { id: secondItem.id } });
    expect(updatedFirst.unitCost.toNumber()).toBe(840);
    expect(updatedSecond.unitCost.toNumber()).toBe(500);
    expect(updatedSecond.isDraft).toBe(false);

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    // The unchecked low-confidence row is completely untouched.
    expect(updatedMatches[2].lineItemId).toBeNull();
    expect(updatedMatches[2].confidence).toBe("low");

    const updatedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(updatedVersion.totalCost.toNumber()).toBe(1340);

    const logs = await db.vendorMatchApplyLog.findMany({ where: { estimateVersionId: version.id } });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.method === "selected" && l.actorId === admin.id)).toBe(true);
    // The medium-confidence row (index 1) had no resolved lineItemId at
    // all, only a suggestion -- confirms the log reflects what was
    // ACTUALLY written (via lineItemId ?? suggestedLineItemId), not just
    // what the match row's confidence label said going in.
    const secondLog = logs.find((l) => l.lineItemId === secondItem.id);
    expect(secondLog?.confidence).toBe("high");
    expect(secondLog?.unitCost.toNumber()).toBe(500);
  });

  it("sums qty/price across two checked rows that share the same target", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });
    const matches: VendorLineMatch[] = [
      match(vendorLine("Non Slip Paint", 450, 1), { lineItemId: item.id, confidence: "high" }),
      match(vendorLine("Guardrail", 425, 1), { lineItemId: item.id, confidence: "high" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const result = await applySelectedVendorMatchesAction(estimate.id, version.id, bidPackage.id, document.id, [0, 1]);

    expect(result.appliedLineItemIds).toEqual([item.id]);
    const updatedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    // qty sums to 2 (1 + 1), price sums to $875 -- unitCost is the
    // resulting per-unit average ($437.50), and totalCost (qty x
    // unitCost) is what actually has to equal the combined $875.
    expect(updatedItem.qty.toNumber()).toBe(2);
    expect(updatedItem.unitCost.toNumber()).toBe(437.5);
    expect(updatedItem.totalCost.toNumber()).toBe(875);
  });

  it("self-heals a checked match pointing at a deleted line item while still applying the rest", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });
    const deletedTargetId = "deleted-line-item-does-not-exist";
    const matches: VendorLineMatch[] = [
      match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" }),
      match(vendorLine("Trucking", 25000), { lineItemId: deletedTargetId, confidence: "high" }),
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    const result = await applySelectedVendorMatchesAction(estimate.id, version.id, bidPackage.id, document.id, [0, 1]);

    expect(result.appliedLineItemIds).toEqual([item.id]);
    expect(result.staleCount).toBe(1);

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    expect(updatedMatches[1].lineItemId).toBeNull();
    expect(updatedMatches[1].confidence).toBe("low");
  });

  it("rejects an empty selection", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });
    await db.bidPackage.update({
      where: { id: bidPackage.id },
      data: { matchResult: [match(vendorLine("Soft Goods", 800), { confidence: "low" })] as object[] },
    });

    await expect(applySelectedVendorMatchesAction(estimate.id, version.id, bidPackage.id, document.id, [])).rejects.toThrow(
      "Select at least one match",
    );
  });

  it("drops an out-of-range index instead of trusting it -- selectedIndices is untrusted client input", async () => {
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
        bidPackageId: bidPackage.id,
      },
    });
    const matches: VendorLineMatch[] = [match(vendorLine("Sleeper Floor Required", 840), { lineItemId: item.id, confidence: "high" })];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { matchResult: matches as object[] } });

    // Index 0 is real; 99 and -1 are hallucinated/out-of-range and must
    // be silently dropped, not crash or apply something unintended.
    const result = await applySelectedVendorMatchesAction(estimate.id, version.id, bidPackage.id, document.id, [0, 99, -1]);

    expect(result.appliedLineItemIds).toEqual([item.id]);
  });
});

describe("commitProposedVendorSectionAction", () => {
  async function makePackageWithProposal() {
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
        bidPackageId: bidPackage.id,
      },
    });
    const lines = [vendorLine("Test and adjust", 189000), vendorLine("Trucking", 25000)];
    const matches: VendorLineMatch[] = lines.map((vl) => match(vl));
    const proposedSections: ProposedVendorSection[] = [
      { name: "One Time Service Costs", lineType: "FEE", reasoning: "Real cost category, no matching section.", vendorLineIndices: [0, 1] },
    ];
    await db.bidPackage.update({
      where: { id: bidPackage.id },
      data: { matchResult: matches as object[], proposedSections: proposedSections as object[] },
    });
    return { admin, estimate, version, bidPackage, document };
  }

  it("creates a real section with priced, non-draft line items, and patches matchResult to show them matched", async () => {
    const { estimate, version, bidPackage } = await makePackageWithProposal();

    const formData = new FormData();
    formData.set("proposedSectionIndex", "0");
    await commitProposedVendorSectionAction(estimate.id, version.id, bidPackage.id, formData);

    const section = await db.estimateSection.findFirstOrThrow({
      where: { estimateVersionId: version.id, name: "One Time Service Costs" },
      include: { lineItems: true },
    });
    expect(section.sectionType).toBe("CATEGORY");
    expect(section.lineItems).toHaveLength(2);
    const testAndAdjust = section.lineItems.find((li) => li.description === "Test and adjust")!;
    expect(testAndAdjust.unitCost.toNumber()).toBe(189000);
    expect(testAndAdjust.isDraft).toBe(false);
    expect(testAndAdjust.bidPackageId).toBe(bidPackage.id);
    expect(testAndAdjust.lineType).toBe("FEE");

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    expect(updatedMatches[0].lineItemId).toBe(testAndAdjust.id);
    expect(updatedMatches[0].confidence).toBe("high");
    expect(updatedMatches[0].needsClarification).toBe(false);
    expect(updated.proposedSections).toEqual([]);
  });

  it("does not duplicate line items when the same proposal is committed twice -- reproduces a live incident where a re-extract re-proposed an already-committed section", async () => {
    const { estimate, version, bidPackage } = await makePackageWithProposal();

    const formData1 = new FormData();
    formData1.set("proposedSectionIndex", "0");
    await commitProposedVendorSectionAction(estimate.id, version.id, bidPackage.id, formData1);

    const section = await db.estimateSection.findFirstOrThrow({
      where: { estimateVersionId: version.id, name: "One Time Service Costs" },
    });
    const firstCommitItems = await db.lineItem.findMany({ where: { sectionId: section.id } });
    expect(firstCommitItems).toHaveLength(2);

    // Simulate a re-extract overwriting matchResult/proposedSections
    // with a fresh AI pass that (incorrectly) re-proposes the exact same
    // section for the exact same vendor lines (same sourceQuote).
    const lines = [vendorLine("Test and adjust", 189000), vendorLine("Trucking", 25000)];
    const freshMatches: VendorLineMatch[] = lines.map((vl) => match(vl));
    const freshProposal: ProposedVendorSection[] = [
      { name: "One Time Service Costs", lineType: "FEE", reasoning: "Real cost category, no matching section.", vendorLineIndices: [0, 1] },
    ];
    await db.bidPackage.update({
      where: { id: bidPackage.id },
      data: { matchResult: freshMatches as object[], proposedSections: freshProposal as object[] },
    });

    const formData2 = new FormData();
    formData2.set("proposedSectionIndex", "0");
    await commitProposedVendorSectionAction(estimate.id, version.id, bidPackage.id, formData2);

    const afterSecondCommit = await db.lineItem.findMany({ where: { sectionId: section.id } });
    expect(afterSecondCommit).toHaveLength(2);
    expect(afterSecondCommit.map((li) => li.id).sort()).toEqual(firstCommitItems.map((li) => li.id).sort());

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    const updatedMatches = updated.matchResult as unknown as VendorLineMatch[];
    const testAndAdjustId = firstCommitItems.find((li) => li.description === "Test and adjust")!.id;
    expect(updatedMatches[0].lineItemId).toBe(testAndAdjustId);
  });

  it("rejects a missing/invalid proposedSectionIndex", async () => {
    const { estimate, version, bidPackage } = await makePackageWithProposal();

    const formData = new FormData();
    await expect(commitProposedVendorSectionAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      "Missing or invalid",
    );
  });

  it("rejects a proposedSectionIndex that no longer exists", async () => {
    const { estimate, version, bidPackage } = await makePackageWithProposal();

    const formData = new FormData();
    formData.set("proposedSectionIndex", "5");
    await expect(commitProposedVendorSectionAction(estimate.id, version.id, bidPackage.id, formData)).rejects.toThrow(
      "no longer exists",
    );
  });
});

describe("dismissProposedVendorSectionAction", () => {
  it("removes the entry from proposedSections without creating anything", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    const proposedSections: ProposedVendorSection[] = [
      { name: "One Time Service Costs", lineType: "FEE", reasoning: "x", vendorLineIndices: [0] },
    ];
    await db.bidPackage.update({ where: { id: bidPackage.id }, data: { proposedSections: proposedSections as object[] } });

    const formData = new FormData();
    formData.set("proposedSectionIndex", "0");
    await dismissProposedVendorSectionAction(estimate.id, bidPackage.id, formData);

    const updated = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    expect(updated.proposedSections).toEqual([]);
    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id } });
    expect(sections.map((s) => s.name)).not.toContain("One Time Service Costs");
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

    // The AI-configured check happens before the phase is ever written --
    // this fails loudly and synchronously, not silently after already
    // looking like it started.
    const unchanged = await db.bidPackage.findUniqueOrThrow({ where: { id: bidPackage.id } });
    expect(unchanged.vendorExtractionPhase).toBe("IDLE");
  });
});

describe("getBidPackageExtractionStatusAction", () => {
  it("returns the bid package's current phase and error", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
    await db.bidPackage.update({
      where: { id: bidPackage.id },
      data: { vendorExtractionPhase: "MATCHING", vendorExtractionError: null },
    });

    const status = await getBidPackageExtractionStatusAction(estimate.id, bidPackage.id);

    expect(status).toEqual({ phase: "MATCHING", error: null });
  });

  it("rejects an unauthenticated caller", async () => {
    const { estimate, version, item } = await makeEstimateWithLineItem();
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });

    await expect(getBidPackageExtractionStatusAction(estimate.id, bidPackage.id)).rejects.toThrow(
      /access|authenticated/i,
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
