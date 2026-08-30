import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import { commitPricingImport, previewPricingImport, type PricingImportPreview } from "@/lib/pricing-import-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";

// previewPricingImport now also dispatches to the Design Cost Estimate
// booth-workbook shape (design-cost-estimate-import-service.ts) and
// returns a union of the two preview types -- every fixture in this file
// is the flat-schedule shape, so this just narrows for TypeScript with a
// real runtime check, rather than every call site repeating an inline
// `if (preview.kind !== "pricing-schedule") throw ...`.
async function previewFlatSchedule(documentId: string, opportunityId: string): Promise<PricingImportPreview> {
  const preview = await previewPricingImport(documentId, opportunityId);
  if (preview.kind !== "pricing-schedule") {
    throw new Error(`Expected a flat pricing-schedule preview, got "${preview.kind}".`);
  }
  return preview;
}

// Real fixture from Phase 7's roadmap RFP package -- see data/RFP/superbowl.
// Ground truth (162 rows / 5 categories) independently verified against
// the workbook with openpyxl before writing this test, the same
// "verified against real data" standard as Yoku Moku's total in
// estimate-service.test.ts. (162, not the 149 an earlier version of this
// importer produced -- 13 real TemporaryBooth_ADD ON alternates, e.g.
// "Rex-Frame temporary wall system" and "Sleeper Floor - 1\" H", carry
// their own text in the Item column with Description left blank, and were
// silently dropped as spacer rows before the Item-column fallback below.)
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Exhibit 1 - SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx",
);

// Two more real fixtures, both from the Super Bowl LXI Scaffolding RFP
// (data/RFP/superbowl/RFP-submission-comparison), each exercising one of
// this file's two real-world header shapes:
// - Arena-template.xlsx: the blank RFP Arena sends OUT to bidders. Its 44
//   named camera/booth/auxiliary positions carry their real name in the
//   Item column ("Right Endzone Camera Platform") and leave Description
//   blank except for a "Sleeper Floor Required" note on a handful of rows
//   -- exercises the Item-column fallback.
// - expocci-revised-rfp-withsgpspricing.xlsx: Arena's own later revision
//   of that same template, filled in with SGPS/ShowRig pricing. Renamed
//   headers ("Location / Item", "Notes", "Planning Qty") -- exercises the
//   header-label synonym matching.
// Ground truth (77 / 76 rows) independently verified against both
// workbooks with openpyxl, and cross-checked live against this service's
// own previewPricingImport before writing these tests.
const ARENA_TEMPLATE_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP-submission-comparison/Arena-template.xlsx",
);
const ARENA_REVISED_WITH_PRICING_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP-submission-comparison/expocci-revised-rfp-withsgpspricing.xlsx",
);

async function makeDocumentFrom(filePath: string, filename: string) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const bytes = await readFile(filePath);
  const file = new File([bytes], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const document = await uploadDocument(opportunity.id, { file, documentType: "PRICING_SCHEDULE" });
  return { opportunity, document };
}

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.rentalItem.deleteMany();
  await db.material.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeDocument() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const bytes = await readFile(FIXTURE_PATH);
  const file = new File([bytes], "Exhibit 1 - Financial Proposal Schedule.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const document = await uploadDocument(opportunity.id, { file, documentType: "PRICING_SCHEDULE" });
  return { opportunity, document };
}

describe("previewPricingImport", () => {
  it("parses the real Exhibit 1 pricing schedule into 162 rows across 5 categories", async () => {
    const { opportunity, document } = await makeDocument();

    const preview = await previewFlatSchedule(document.id, opportunity.id);

    expect(preview.rows).toHaveLength(162);
    expect(preview.categories.sort()).toEqual(
      ["BOOTH_PLATFORM", "CAMERA_PLATFORM", "TemporaryBooth_ADD ON", "TemporaryBooth_BUILD", "TemporaryBooth_SERVICE"].sort(),
    );

    const byCategory = Object.fromEntries(
      preview.categories.map((c) => [c, preview.rows.filter((r) => r.category === c).length]),
    );
    expect(byCategory["TemporaryBooth_BUILD"]).toBe(113);
    expect(byCategory["BOOTH_PLATFORM"]).toBe(30);
    expect(byCategory["CAMERA_PLATFORM"]).toBe(4);

    // Ignores the free-text "add your own item" mini-table further down
    // the sheet (no Category/Qty columns -- not a second pricing table).
    expect(preview.rows.some((r) => r.description === "Description")).toBe(false);

    // Real row 9: a known, human-checked line item.
    const first = preview.rows[0];
    expect(first.description).toContain("Complete Booth Build");
    expect(first.unit).toBe("EA");
    expect(first.qty).toBe(1);
  });

  it("suggests a catalog rate when a row's description confidently matches a real catalog entry", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const { opportunity, document } = await makeDocument();

    const preview = await previewFlatSchedule(document.id, opportunity.id);
    const doorRow = preview.rows.find((r) => r.description.toLowerCase().includes("compliant door"));

    expect(doorRow).toBeDefined();
    expect(doorRow?.catalogMatch).toEqual({ source: "Rental", name: "Doors", unitCost: 150, category: null });
  });

  it("leaves catalogMatch null for a turnkey line description with no real catalog vocabulary overlap", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const { opportunity, document } = await makeDocument();

    const preview = await previewFlatSchedule(document.id, opportunity.id);
    const boothBuildRow = preview.rows.find((r) => r.description.includes("Complete Booth Build"));

    expect(boothBuildRow?.catalogMatch).toBeNull();
  });

  it("rejects a document with no recognizable Pricing Schedule sheet", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const file = new File([Buffer.from("not a spreadsheet")], "notes.txt", { type: "text/plain" });
    const document = await uploadDocument(opportunity.id, { file, documentType: "OTHER" });

    await expect(previewPricingImport(document.id, opportunity.id)).rejects.toThrow();
  });

  // Regression test for the cross-resource ID authorization gap: this
  // previously trusted documentId alone, letting a caller preview (and,
  // via commitPricingImport, commit) a DIFFERENT opportunity's pricing
  // schedule -- see previewPricingImport's own header comment.
  it("rejects a documentId that belongs to a different opportunity", async () => {
    const { document } = await makeDocument();
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(previewPricingImport(document.id, otherOpportunity.id)).rejects.toThrow(
      "This document doesn't belong to this opportunity.",
    );
  });
});

describe("commitPricingImport", () => {
  it("creates one CATEGORY section per distinct (booth, category) pair, grouping booth-labeled sections under a shared groupLabel", async () => {
    const { opportunity, document } = await makeDocument();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitPricingImport(version.id, document.id);

    // 17 distinct booth/exhibit instances x 2 categories each (Booth
    // Build + Platform), plus 2 booth-independent categories (Add-Ons,
    // Show Services) -- not just 5 flat categories -- see
    // pricing-import-service.ts's groupLabel comment.
    expect(result.sectionsCreated).toBe(36);
    expect(result.rowsImported).toBe(162);

    const sections = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    expect(sections).toHaveLength(36);

    // Real booth's "Item" header cell is richText with mixed run
    // formatting -- a real regression where a naive String(cell.value)
    // stringified it to "[object Object]" instead of its actual text,
    // silently leaving every row's booth grouping off.
    const boothSections = sections.filter((s) => s.groupLabel !== null);
    expect(boothSections).toHaveLength(34);
    expect(new Set(boothSections.map((s) => s.groupLabel)).size).toBe(17);
    const camera203 = boothSections.filter((s) => s.groupLabel === "Section 203 - Camera Booth - Page 2 & 3");
    expect(camera203.map((s) => s.name).sort()).toEqual(["Booth Build", "Platform"]);

    // The two booth-independent categories stay standalone (no groupLabel).
    const standalone = sections.filter((s) => s.groupLabel === null);
    expect(standalone.map((s) => s.name).sort()).toEqual(["Add-Ons & Alternates", "Show Services"]);

    const allLineItems = sections.flatMap((s) => s.lineItems);
    expect(allLineItems).toHaveLength(162);
    expect(allLineItems.every((li) => li.isDraft)).toBe(true);
    expect(allLineItems.every((li) => li.documentId === document.id)).toBe(true);
    // No catalog rows exist in this test's DB state, so every match is
    // null and every unitCost stays at the $0 fallback -- see the
    // dedicated catalog-match test below for the non-empty-catalog case.
    expect(allLineItems.every((li) => li.unitCost.toNumber() === 0)).toBe(true);


    // Drafts are excluded from totals until confirmed -- same gate as
    // the attachmentId-sourced draft flow.
    const refreshedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(refreshedVersion.totalCost.toNumber()).toBe(0);

    // The check-and-balance: every row's sourceQuote is its own real
    // Description cell text, verbatim -- not something derived or
    // guessed, so it's guaranteed to be findable again in the rendered
    // spreadsheet viewer (see document-view-service.ts's findSpreadsheetMatch).
    const complete = allLineItems.find((li) => li.description.includes("Complete Booth Build"));
    expect(complete?.sourceQuote).toContain("Complete Booth Build");
    expect(allLineItems.every((li) => li.sourceQuote && li.sourceQuote.length > 0)).toBe(true);
    expect(allLineItems.every((li) => li.sourcePageNumber === null)).toBe(true); // XLSX has no page concept
  });

  it("seeds unitCost from a confident catalog match instead of leaving it at $0", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const { opportunity, document } = await makeDocument();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitPricingImport(version.id, document.id);

    const sections = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    const allLineItems = sections.flatMap((s) => s.lineItems);
    const doorItems = allLineItems.filter((li) => li.description.toLowerCase().includes("compliant door"));

    expect(doorItems.length).toBeGreaterThan(0);
    expect(doorItems.every((li) => li.unitCost.toNumber() === 150)).toBe(true);
    // Still isDraft -- a seeded rate doesn't bypass the confirm-before-it-counts gate.
    expect(doorItems.every((li) => li.isDraft)).toBe(true);
  });

  it("refuses a second import of the same document into the same version, rather than duplicating every section and item", async () => {
    const { opportunity, document } = await makeDocument();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitPricingImport(version.id, document.id);
    await expect(commitPricingImport(version.id, document.id)).rejects.toThrow(/already been imported/);

    // The real bug this guards against: a real Super Bowl 2026 estimate
    // had this exact document imported twice before this check existed,
    // doubling all 162 rows to 324.
    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id } });
    expect(sections).toHaveLength(36);
    const lineItemCount = await db.lineItem.count({ where: { section: { estimateVersionId: version.id } } });
    expect(lineItemCount).toBe(162);
  });

  it("rejects committing a document that belongs to a different opportunity than the target estimate", async () => {
    const { document } = await makeDocument(); // belongs to its own opportunity
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });
    const otherEstimate = await db.estimate.create({ data: { opportunityId: otherOpportunity.id } });
    const otherVersion = await createEstimateVersion(otherEstimate.id, 0);

    await expect(commitPricingImport(otherVersion.id, document.id)).rejects.toThrow(
      "This document doesn't belong to this opportunity.",
    );

    const lineItemCount = await db.lineItem.count({ where: { section: { estimateVersionId: otherVersion.id } } });
    expect(lineItemCount).toBe(0);
  });
});

describe("previewPricingImport -- Arena RFP header shape variants", () => {
  it("recovers all 44 named positions from Arena-template.xlsx by falling back to the Item column when Description is blank", async () => {
    const { opportunity, document } = await makeDocumentFrom(ARENA_TEMPLATE_PATH, "Arena-template.xlsx");

    const preview = await previewFlatSchedule(document.id, opportunity.id);

    // Before the Item-column fallback, 78 of these 96 candidate rows were
    // silently dropped as spacer rows (verified live against this exact
    // file) -- only the 18 rows with a real Description-cell note
    // survived. 77 is the corrected, verified total.
    expect(preview.rows).toHaveLength(77);
    const byCategory = Object.fromEntries(
      preview.categories.map((c) => [c, preview.rows.filter((r) => r.category === c).length]),
    );
    expect(byCategory["CAMERA_PLATFORM"]).toBe(20);
    expect(byCategory["BOOTH_PLATFORM"]).toBe(14);
    expect(byCategory["AUXILLARY_PLATFORM"]).toBe(10);

    // A named position with NO Description-cell note at all -- this row
    // would have been dropped entirely before the fallback.
    const namedPosition = preview.rows.find((r) => r.item === "Right Endzone Camera Platform");
    expect(namedPosition).toBeDefined();
    expect(namedPosition?.description).toBe("Right Endzone Camera Platform");

    // A row where BOTH Item and Description hold real, DIFFERENT text
    // combines them -- confirmed live in production: 11 different booth
    // positions all shared the literal same generic Description text
    // ("Sleeper floor required") with no way to tell them apart in the
    // match-review dropdown once Item's own distinguishing name was
    // discarded. sourceQuote (the citation-highlight anchor) stays the
    // single verbatim Description cell regardless.
    const sleeperNote = preview.rows.find((r) => r.item === "Section 203 - Main Far Left Slash Camera");
    expect(sleeperNote?.description).toBe('Section 203 - Main Far Left Slash Camera — Sleeper Floor Required 1"');
    expect(sleeperNote?.sourceQuote).toBe('Sleeper Floor Required 1"');
  });

  it("recognizes expocci-revised-rfp-withsgpspricing.xlsx despite its renamed headers (Location / Item, Notes, Planning Qty)", async () => {
    const { opportunity, document } = await makeDocumentFrom(
      ARENA_REVISED_WITH_PRICING_PATH,
      "expocci-revised-rfp-withsgpspricing.xlsx",
    );

    // Before the header-synonym matching, this threw "doesn't contain a
    // recognizable Pricing Schedule sheet" -- verified live against this
    // exact file, which was otherwise byte-for-byte the same RFP shape.
    const preview = await previewFlatSchedule(document.id, opportunity.id);

    expect(preview.rows).toHaveLength(76);
    const byCategory = Object.fromEntries(
      preview.categories.map((c) => [c, preview.rows.filter((r) => r.category === c).length]),
    );
    expect(byCategory["CAMERA_PLATFORM"]).toBe(20);
    expect(byCategory["BOOTH_PLATFORM"]).toBe(14);

    // Confirms the renamed Unit/Planning-Qty columns resolved to the
    // right column offsets, not just that a header row was found at all.
    const priced = preview.rows.find((r) => r.item === "Right Endzone Camera Platform — Near");
    expect(priced?.unit).toBe("SF");
    expect(priced?.qty).toBe(1);

    // This file's own "Ref." column ("CAM-01") is the real, human-built
    // crosswalk between Arena's location name and ShowRig's own vendor
    // quote codes -- captured here so vendor-match-ai-service.ts can
    // match a vendor line's unitCode against it deterministically instead
    // of re-guessing the correspondence from text alone every time.
    expect(priced?.positionCode).toBe("CAM-01");
  });

  it("commits positionCode onto the real LineItem row so it survives past the preview", async () => {
    const { opportunity, document } = await makeDocumentFrom(
      ARENA_REVISED_WITH_PRICING_PATH,
      "expocci-revised-rfp-withsgpspricing.xlsx",
    );
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitPricingImport(version.id, document.id);

    const lineItem = await db.lineItem.findFirstOrThrow({
      where: { section: { estimateVersionId: version.id }, positionCode: "CAM-01" },
    });
    // Combined -- Item ("Right Endzone Camera Platform — Near") is the
    // real distinguishing name, Description ("Field-level, turf edge...")
    // is a supplementary note; both survive onto the real LineItem row.
    expect(lineItem.description).toBe("Right Endzone Camera Platform — Near — Field-level, turf edge; 3 camera positions");
    expect(lineItem.sourceQuote).toBe("Field-level, turf edge; 3 camera positions");
  });
});

// Real fixtures from the "Full Swing PGA Orlando" job -- confirmed live
// to match neither findDesignCostEstimateSheet nor findPricingSheet, the
// exact condition that should route previewPricingImport to
// spreadsheet-line-item-service.ts's AI fallback instead of throwing the
// old "doesn't contain a recognizable Pricing Schedule sheet" error.
const FUSE_BID_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/Full_Swing/EXPO_CCI_Full_Swing_PGA_Orlando_Bid_Breakdown.xlsx",
);
const FABRICATION_ESTIMATE_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/Full_Swing/Full Swing @ PGA 2027 Orlando Estimate 082526TA.xlsx",
);

describe("previewPricingImport -- AI fallback dispatch", () => {
  it.each([
    ["the real Fuse AV/lighting/rigging bid", FUSE_BID_PATH],
    ["the real 33-sheet internal fabrication estimate", FABRICATION_ESTIMATE_PATH],
  ])("reaches the AI fallback (not the old unrecognized-format error) for %s", async (_label, filePath) => {
    const { opportunity, document } = await makeDocumentFrom(filePath, "unrecognized-format.xlsx");

    // .env.test deliberately has no OpenAI key -- AiNotConfiguredError
    // proves the AI fallback was actually reached, not the deterministic
    // "doesn't contain a recognizable Pricing Schedule sheet" error this
    // used to throw for exactly these two real files.
    await expect(previewPricingImport(document.id, opportunity.id)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});
