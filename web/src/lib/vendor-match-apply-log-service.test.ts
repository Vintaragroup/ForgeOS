import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLineItem, addSection, createBidPackage, createEstimateVersion } from "@/lib/estimate-service";
import { getVendorMatchApplyLog, recordVendorMatchApply } from "@/lib/vendor-match-apply-log-service";

afterEach(async () => {
  await db.vendorMatchApplyLog.deleteMany();
  await db.lineItem.deleteMany();
  await db.document.deleteMany();
  await db.bidPackage.deleteMany();
  await db.estimateSection.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeScenario() {
  const user = await db.user.create({ data: { name: "Admin", email: `${Math.random()}@test.com`, systemRole: "ADMIN" } });
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
  });
  const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });
  const document = await db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "ShowRig quote.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      storageKey: "test/key",
      documentType: "VENDOR_QUOTE",
    },
  });
  return { user, estimate, version, section, item, bidPackage, document };
}

describe("recordVendorMatchApply / getVendorMatchApplyLog", () => {
  it("persists a full snapshot and reads it back with the actor's name attached", async () => {
    const { user, version, item, bidPackage, document } = await makeScenario();

    await recordVendorMatchApply({
      estimateVersionId: version.id,
      bidPackageId: bidPackage.id,
      bidPackageName: bidPackage.name,
      lineItemId: item.id,
      targetDescription: item.description,
      targetSectionLabel: "Flooring",
      vendorLineDescriptions: ["Sleeper Floor", "Sleeper Floor Extra"],
      qty: 2,
      unitCost: 420,
      totalCost: 840,
      confidence: "high",
      documentId: document.id,
      documentFilename: document.filename,
      method: "group",
      actorId: user.id,
    });

    const log = await getVendorMatchApplyLog(version.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      method: "group",
      vendorLineCount: 2,
      vendorLineDescriptions: "Sleeper Floor | Sleeper Floor Extra",
      confidence: "high",
      documentFilename: "ShowRig quote.pdf",
      actor: { id: user.id, name: user.name },
    });
    expect(log[0].qty.toNumber()).toBe(2);
    expect(log[0].unitCost.toNumber()).toBe(420);
    expect(log[0].totalCost.toNumber()).toBe(840);
  });

  it("survives the referenced line item being deleted -- the snapshot stays legible, the live pointer goes null", async () => {
    const { user, version, item, bidPackage, document } = await makeScenario();

    await recordVendorMatchApply({
      estimateVersionId: version.id,
      bidPackageId: bidPackage.id,
      bidPackageName: bidPackage.name,
      lineItemId: item.id,
      targetDescription: item.description,
      targetSectionLabel: "Flooring",
      vendorLineDescriptions: ["Sleeper Floor"],
      qty: 1,
      unitCost: 840,
      totalCost: 840,
      confidence: "high",
      documentId: document.id,
      documentFilename: document.filename,
      method: "single",
      actorId: user.id,
    });

    await db.lineItem.delete({ where: { id: item.id } });

    const log = await getVendorMatchApplyLog(version.id);
    expect(log).toHaveLength(1);
    expect(log[0].lineItemId).toBeNull();
    // The snapshot -- the whole point of this table -- is untouched.
    expect(log[0].targetDescription).toBe("Sleeper Floor Required");
    expect(log[0].targetSectionLabel).toBe("Flooring");
  });

  it("orders most-recent first", async () => {
    const { user, version, item, bidPackage, document } = await makeScenario();
    const base = {
      estimateVersionId: version.id,
      bidPackageId: bidPackage.id,
      bidPackageName: bidPackage.name,
      lineItemId: item.id,
      targetDescription: item.description,
      targetSectionLabel: "Flooring",
      vendorLineDescriptions: ["Sleeper Floor"],
      qty: 1,
      unitCost: 100,
      totalCost: 100,
      confidence: "high" as const,
      documentId: document.id,
      documentFilename: document.filename,
      method: "single" as const,
      actorId: user.id,
    };
    await recordVendorMatchApply({ ...base, unitCost: 100, totalCost: 100 });
    await recordVendorMatchApply({ ...base, unitCost: 200, totalCost: 200 });

    const log = await getVendorMatchApplyLog(version.id);
    expect(log.map((l) => l.unitCost.toNumber())).toEqual([200, 100]);
  });
});
