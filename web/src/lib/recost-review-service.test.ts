import ExcelJS from "exceljs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { buildRecostReview } from "@/lib/recost-review-service";

// The workbooks live in blob storage, which a test has no business
// reaching. Everything else here is real: real rows, real parsing, real
// arithmetic. What is faked is the byte fetch and nothing else.
const bytesByDocumentId = new Map<string, Buffer>();

vi.mock("@/lib/document-service", () => ({
  getDocumentBytes: async (documentId: string) => {
    const bytes = bytesByDocumentId.get(documentId);
    if (!bytes) throw new Error(`no bytes for ${documentId}`);
    return { document: { id: documentId }, bytes };
  },
}));

afterEach(async () => {
  bytesByDocumentId.clear();
  await db.proposalEvent.deleteMany();
  await db.proposal.deleteMany();
  await db.proposalTemplate.deleteMany();
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

// A summary sheet in the shape the real cost breakouts use, down to the
// empty spacer column between the total and the estimator's status.
async function summaryWorkbook(rows: { element: string; total: number; status?: string }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Summary");
  sheet.addRow(["Client", "Element", "", "", "", "", "Project Total", "", ""]);
  for (const row of rows) {
    sheet.addRow(["Full Swing", row.element, "", "", "", "", row.total, "", row.status ?? ""]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function seed(options: {
  requestNote?: string;
  documents: {
    key: string;
    filename: string;
    validity?: "CURRENT" | "WITHDRAWN";
    validityNote?: string;
    supersedesKey?: string;
    lineItemCosts?: number[];
    summary?: { element: string; total: number; status?: string }[];
  }[];
  currentCost: number;
  currentSell: number;
}) {
  const company = await db.company.create({ data: { name: "Full Swing" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "ABCA Chicago", stage: "ESTIMATING" },
  });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const v1 = await db.estimateVersion.create({
    data: { estimateId: estimate.id, versionNumber: 1, isLocked: true },
  });
  const version = await db.estimateVersion.create({
    data: {
      estimateId: estimate.id,
      versionNumber: 2,
      isLocked: false,
      totalCost: options.currentCost,
      grandTotal: options.currentSell,
    },
  });
  const section = await db.estimateSection.create({
    data: { estimateVersionId: version.id, name: "Fabrication", sectionType: "COMPONENT" },
  });

  const ids = new Map<string, string>();
  // Two passes: a document cannot point at a successor that does not
  // exist yet.
  for (const doc of options.documents) {
    const created = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: doc.filename,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 1,
        storageKey: `test/${doc.key}`,
        documentType: "PRICING_SCHEDULE",
        validity: doc.validity ?? "CURRENT",
        validityNote: doc.validityNote ?? null,
      },
    });
    ids.set(doc.key, created.id);
    if (doc.summary) bytesByDocumentId.set(created.id, await summaryWorkbook(doc.summary));
  }
  for (const doc of options.documents) {
    if (!doc.supersedesKey) continue;
    await db.document.update({
      where: { id: ids.get(doc.key)! },
      data: { supersedesId: ids.get(doc.supersedesKey)! },
    });
  }
  for (const doc of options.documents) {
    for (const [i, cost] of (doc.lineItemCosts ?? []).entries()) {
      await db.lineItem.create({
        data: {
          sectionId: section.id,
          documentId: ids.get(doc.key)!,
          lineType: "MATERIAL",
          description: `${doc.key} ${i}`,
          qty: 1,
          unitCost: cost,
          totalCost: cost,
        },
      });
    }
  }

  if (options.requestNote) {
    const template = await db.proposalTemplate.create({ data: { name: "Standard" } });
    const proposal = await db.proposal.create({
      data: { estimateVersionId: v1.id, templateId: template.id, status: "REVISIONS_REQUESTED" },
    });
    await db.proposalEvent.create({
      data: { proposalId: proposal.id, toStatus: "REVISIONS_REQUESTED", note: options.requestNote },
    });
  }

  return estimate.id;
}

describe("buildRecostReview", () => {
  it("reads the estimator's own statuses into a gap against the client's number", async () => {
    const estimateId = await seed({
      requestNote: "client requested a revised design and estimate to meet their budget of 250k",
      currentCost: 399486.24,
      currentSell: 658785.1,
      documents: [
        {
          key: "v1",
          filename: "Cost_Breakout.xlsx",
          lineItemCosts: [43849.05, 7469.02],
          summary: [
            { element: "Hitting Bay Wall Structure", total: 43849.05 },
            { element: "Reception Counter", total: 7469.02 },
            { element: "Lit Angled Spines (Lounge)", total: 37280.6 },
          ],
        },
        {
          key: "v2",
          filename: "estimates updated 091826.xlsx",
          supersedesKey: "v1",
          summary: [
            { element: "Hitting Bay Wall Structure", total: 19202.35, status: "Updated 091826 TA" },
            { element: "Reception Counter", total: 0, status: "Eliminated 091827 TA" },
            { element: "Lit Angled Spines (Lounge)", total: 37280.6, status: "No  change 091827 TA" },
          ],
        },
      ],
    });

    const review = await buildRecostReview(estimateId);
    expect(review).not.toBeNull();
    expect(review!.versionNumber).toBe(2);
    expect(review!.rollup.target).toBe(250000);

    // -24,646.70 and -7,469.02.
    expect(review!.rollup.knownCostDelta).toBeCloseTo(-32115.72, 2);
    expect(review!.rollup.gap).toBeGreaterThan(0);

    const line = review!.rollup.lines.find((l) => l.label === "Cost_Breakout.xlsx");
    expect(line?.status).toBe("RECOSTED");
    expect(line?.detail).toContain("1 eliminated, 1 repriced, 1 unchanged");
  });

  // The rule the whole feature exists to protect: a source dying removes
  // nothing and saves nothing. Its money becomes a question.
  it("treats a withdrawn source as money at risk, never as a saving", async () => {
    const estimateId = await seed({
      requestNote: "budget of 250k",
      currentCost: 399486.24,
      currentSell: 658785.1,
      documents: [
        {
          key: "fuse",
          filename: "Fuse_AV_Quote.pdf",
          validity: "WITHDRAWN",
          validityNote: "Fuse is no longer supplying AV on this job",
          lineItemCosts: [30000, 16830],
        },
      ],
    });

    const review = await buildRecostReview(estimateId);
    const line = review!.rollup.lines[0];
    expect(line.status).toBe("NEEDS_RESOURCING");
    expect(line.costAtRisk).toBeCloseTo(46830, 2);
    expect(line.costDelta).toBeNull();
    // Unmoved: nothing has been priced.
    expect(review!.rollup.knownCostDelta).toBe(0);
    expect(review!.rollup.projectedSell).toBeCloseTo(658785.1, 2);
    expect(review!.notes.join(" ")).toContain("not counted as a saving");
  });

  // Two sentences get joined here, and the estimator's note ends wherever
  // they stopped typing.
  it("does not run the estimator's note into the sentence after it", async () => {
    const estimateId = await seed({
      currentCost: 100,
      currentSell: 100,
      documents: [
        {
          key: "fuse",
          filename: "Fuse_AV_Quote.pdf",
          validity: "WITHDRAWN",
          validityNote: "Fuse is no longer supplying AV on this job",
          lineItemCosts: [100],
        },
      ],
    });

    const review = await buildRecostReview(estimateId);
    expect(review!.rollup.lines[0].detail).toContain("on this job. 1 line items");
  });

  // Unreadable is not the same as unchanged. A superseded source whose
  // replacement cannot be parsed has to stay on the screen as a question.
  it("keeps a superseded source visible when its replacement cannot be read", async () => {
    const estimateId = await seed({
      currentCost: 1000,
      currentSell: 1000,
      documents: [
        { key: "v1", filename: "Old_Quote.pdf", lineItemCosts: [1000] },
        { key: "v2", filename: "New_Quote.pdf", supersedesKey: "v1" },
      ],
    });

    const review = await buildRecostReview(estimateId);
    const line = review!.rollup.lines[0];
    expect(line.status).toBe("NEEDS_REVIEW");
    expect(line.costDelta).toBeNull();
    expect(line.costAtRisk).toBeCloseTo(1000, 2);
    expect(line.detail).toContain("no readable element summary");
  });

  it("names the biggest untouched elements while the gap is open", async () => {
    const estimateId = await seed({
      requestNote: "come in at 250000",
      currentCost: 399486.24,
      currentSell: 658785.1,
      documents: [
        {
          key: "v1",
          filename: "Cost_Breakout.xlsx",
          lineItemCosts: [1000],
          summary: [
            { element: "Lounge Wall Structure", total: 47797.91 },
            { element: "Lit Angled Spines", total: 37280.6 },
            { element: "Hitting Bay Wall", total: 43849.05 },
          ],
        },
        {
          key: "v2",
          filename: "Revised.xlsx",
          supersedesKey: "v1",
          summary: [
            { element: "Lounge Wall Structure", total: 47797.91, status: "No change 091827 TA" },
            { element: "Lit Angled Spines", total: 37280.6, status: "No change 091827 TA" },
            { element: "Hitting Bay Wall", total: 19202.35, status: "Updated 091826 TA" },
          ],
        },
      ],
    });

    const review = await buildRecostReview(estimateId);
    expect(review!.suggestions.map((s) => s.label)).toEqual(["Lounge Wall Structure", "Lit Angled Spines"]);
  });

  it("returns nothing for an estimate with no open version", async () => {
    const company = await db.company.create({ data: { name: "X" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "X", stage: "ESTIMATING" },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    await db.estimateVersion.create({ data: { estimateId: estimate.id, versionNumber: 1, isLocked: true } });

    expect(await buildRecostReview(estimate.id)).toBeNull();
  });
});
