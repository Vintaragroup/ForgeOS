import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

// Only the byte fetch is faked. The parsing, the diff, the join and the
// writes are all the real path.
const bytesByDocumentId = new Map<string, Buffer>();
vi.mock("@/lib/document-service", () => ({
  getDocumentBytes: async (documentId: string) => {
    const bytes = bytesByDocumentId.get(documentId);
    if (!bytes) throw new Error(`no bytes for ${documentId}`);
    return { document: { id: documentId }, bytes };
  },
}));

const { proposeFromCostBreakout } = await import("@/lib/recost-row-proposal-service");

// One element tab in Full Swing's real shape.
async function workbook(rows: [string, string, number, number][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("FS - Sign 3ft10 Qty4");
  const banner = (t: string) => ws.addRow([t, t, t, t, t, t, t]);
  banner("Full Swing - Diamond Sign Logo 3'10\"");
  banner("OTHER ITEMS");
  ws.addRow(["Category", "Item", "Description", "Unit Cost", "Units", "Quantity", "Total Cost"]);
  for (const [item, desc, unitCost, qty] of rows) {
    ws.addRow(["Lighting", item, desc, unitCost, "Each", qty, unitCost * qty]);
  }
  banner("Other Items Subtotal");
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let estimateId = "";
let versionId = "";
let userId = "";
let lineItemId = "";

async function seed(previousRows: [string, string, number, number][], revisedRows: [string, string, number, number][]) {
  const user = await db.user.create({ data: { email: "e@test.com", name: "E", systemRole: "EMPLOYEE" } });
  userId = user.id;
  const company = await db.company.create({ data: { name: "Full Swing" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "ABCA", stage: "ESTIMATING" },
  });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  estimateId = estimate.id;
  const version = await db.estimateVersion.create({
    data: { estimateId: estimate.id, versionNumber: 2, isLocked: false },
  });
  versionId = version.id;
  const section = await db.estimateSection.create({
    data: {
      estimateVersionId: version.id,
      name: "Signs",
      groupLabel: "FS - Sign 3ft10 Qty4",
      sectionType: "COMPONENT",
    },
  });
  for (const [item, , unitCost, qty] of previousRows) {
    const created = await db.lineItem.create({
      data: { sectionId: section.id, lineType: "MATERIAL", description: item, qty, unitCost, totalCost: unitCost * qty },
    });
    lineItemId ||= created.id;
  }

  const previous = await db.document.create({
    data: { opportunityId: opportunity.id, filename: "v1.xlsx", mimeType: "x", sizeBytes: 1, storageKey: "a", documentType: "PRICING_SCHEDULE" },
  });
  const revised = await db.document.create({
    data: {
      opportunityId: opportunity.id, filename: "v2.xlsx", mimeType: "x", sizeBytes: 1, storageKey: "b",
      documentType: "PRICING_SCHEDULE", supersedesId: previous.id,
    },
  });
  bytesByDocumentId.set(previous.id, await workbook(previousRows));
  bytesByDocumentId.set(revised.id, await workbook(revisedRows));
  return { previous, revised };
}

beforeEach(() => {
  lineItemId = "";
});

afterEach(async () => {
  bytesByDocumentId.clear();
  await db.recostProposal.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("proposeFromCostBreakout", () => {
  it("proposes the estimator's own numbers, recommended rather than questioned", async () => {
    await seed([["LED Driver", "", 85, 5]], [["LED Driver", "", 85, 2]]);
    const run = await proposeFromCostBreakout(estimateId, userId);

    expect(run).toEqual({ proposed: 1, unjoined: 0, ambiguous: 0 });
    const [p] = await db.recostProposal.findMany();
    expect(p.action).toBe("ADJUST_QTY");
    expect(p.newQty?.toNumber()).toBe(2);
    // No model read this, so it does not arrive as a question.
    expect(p.confidence).toBe("RECOMMEND_AND_CONFIRM");
    // Checkable in the file itself.
    expect(p.sourceQuote).toContain("qty 5 → 2");
    expect(p.sourceLocation).toBe("FS - Sign 3ft10 Qty4");
  });

  it("calls a price move a reprice", async () => {
    await seed([["LED Driver", "", 85, 5]], [["LED Driver", "", 60, 5]]);
    await proposeFromCostBreakout(estimateId, userId);
    const [p] = await db.recostProposal.findMany();
    expect(p.action).toBe("REPRICE");
    expect(p.newUnitCost?.toNumber()).toBe(60);
  });

  // Taking scope off a job is a judgement even when the workbook is
  // unambiguous. Value engineering removes almost nothing.
  it("leaves a removal as a decision", async () => {
    await seed([["LED Driver", "", 85, 5], ["Extension cord", "", 17, 8]], [["LED Driver", "", 85, 5]]);
    await proposeFromCostBreakout(estimateId, userId);
    const [p] = await db.recostProposal.findMany({ where: { action: "REMOVE" } });
    expect(p.confidence).toBe("NEED_YOUR_DECISION");
    // Nothing to write on a removal -- the row is going.
    expect(p.newQty).toBeNull();
    expect(p.newUnitCost).toBeNull();
  });

  // Two rows sharing a description with the same price cannot be told
  // apart. Picking one is a guess, and this stage does not guess.
  it("declines a row it cannot pin to exactly one line item", async () => {
    await seed(
      [["China Birch", "", 46.5, 2], ["China Birch", "", 46.5, 2]],
      [["China Birch", "", 46.5, 1], ["China Birch", "", 46.5, 2]],
    );
    const run = await proposeFromCostBreakout(estimateId, userId);
    expect(run.ambiguous).toBe(1);
    expect(run.proposed).toBe(0);
    expect(await db.recostProposal.count()).toBe(0);
  });

  it("counts a row with no line item behind it rather than inventing one", async () => {
    const { previous, revised } = await seed([["LED Driver", "", 85, 5]], [["LED Driver", "", 85, 2]]);
    await db.lineItem.deleteMany();
    void previous;
    void revised;

    const run = await proposeFromCostBreakout(estimateId, userId);
    expect(run).toEqual({ proposed: 0, unjoined: 1, ambiguous: 0 });
  });

  it("replaces its own undecided proposals on a re-run and leaves decided ones", async () => {
    await seed([["LED Driver", "", 85, 5]], [["LED Driver", "", 85, 2]]);
    await proposeFromCostBreakout(estimateId, userId);
    const first = await db.recostProposal.findFirstOrThrow();
    await db.recostProposal.update({ where: { id: first.id }, data: { status: "ACCEPTED" } });

    await proposeFromCostBreakout(estimateId, userId);
    const all = await db.recostProposal.findMany();
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.status === "ACCEPTED")).toHaveLength(1);
    expect(all.filter((p) => p.status === "PROPOSED")).toHaveLength(1);
  });

  it("says so when no revised breakout has been linked", async () => {
    await seed([["LED Driver", "", 85, 5]], [["LED Driver", "", 85, 2]]);
    await db.document.updateMany({ data: { supersedesId: null } });
    await expect(proposeFromCostBreakout(estimateId, userId)).rejects.toThrow(/No revised cost breakout/i);
  });
});
