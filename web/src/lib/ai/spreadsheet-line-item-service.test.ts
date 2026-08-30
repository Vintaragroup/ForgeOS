import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  buildSpreadsheetProposalSchema,
  commitAiProposedImport,
  previewAiProposedImport,
  type ProposedSpreadsheetLineItem,
} from "@/lib/ai/spreadsheet-line-item-service";

// The real Fuse Technical Group bid -- confirmed live (this session's own
// investigation) to match neither of pricing-import-service.ts's two
// deterministic detectors, which is exactly the condition that routes a
// document to this file's AI fallback.
const FUSE_BID_PATH = path.resolve(
  import.meta.dirname,
  "../../../../data/RFP/Full_Swing/EXPO_CCI_Full_Swing_PGA_Orlando_Bid_Breakdown.xlsx",
);

async function makeDocument() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const bytes = await readFile(FUSE_BID_PATH);
  const file = new File([bytes], "Fuse Bid.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const document = await uploadDocument(opportunity.id, { file, documentType: "PRICING_SCHEDULE" });
  return { opportunity, document };
}

const FAKE_PROPOSAL: ProposedSpreadsheetLineItem[] = [
  {
    description: "LED Circular Header -- 30' Diameter x 5'h",
    qty: 1,
    qtyIsExplicit: true,
    unit: "LOT",
    unitCost: 31360,
    unitCostIsExplicit: true,
    category: "Audio/Visual",
    sourceQuote: "LED Circular Header  —  30' Diameter x 5'h  (Graphite 2.6, 17088x576, 92A@208V/3ph)",
    sheetName: "Video V1",
  },
  {
    description: "Rigging labor",
    qty: 1,
    qtyIsExplicit: false,
    unit: "LOT",
    unitCost: 20300,
    unitCostIsExplicit: true,
    category: "Labor",
    sourceQuote: "Labor Sub-Total",
    sheetName: "Rigging",
  },
];

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.category.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("previewAiProposedImport", () => {
  it("throws AiNotConfiguredError before writing anything, for a real un-cached document -- .env.test deliberately has no API key", async () => {
    const { opportunity, document } = await makeDocument();

    await expect(previewAiProposedImport(document.id, opportunity.id)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const reloaded = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(reloaded.proposedLineItems).toBeNull();
  });

  it("returns a cached proposal without ever touching the OpenAI client -- proves repeated Preview import clicks don't re-spend tokens", async () => {
    const { opportunity, document } = await makeDocument();
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: FAKE_PROPOSAL as unknown as Prisma.InputJsonValue },
    });

    const preview = await previewAiProposedImport(document.id, opportunity.id);

    expect(preview.kind).toBe("ai-proposed");
    expect(preview.rows).toHaveLength(2);
    expect(preview.categories.sort()).toEqual(["Audio/Visual", "Labor"]);
  });

  it("rejects a document that belongs to a different opportunity", async () => {
    const { document } = await makeDocument();
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(previewAiProposedImport(document.id, otherOpportunity.id)).rejects.toThrow(/doesn't belong to this opportunity/);
  });
});

describe("commitAiProposedImport", () => {
  it("commits a cached proposal as isDraft LineItems, using the AI's own unitCost directly and its category as an explicit hint", async () => {
    const { opportunity, document } = await makeDocument();
    await db.category.createMany({
      data: [
        { name: "Audio/Visual", key: "audio_visual" },
        { name: "Labor", key: "labor" },
      ],
    });
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: FAKE_PROPOSAL as unknown as Prisma.InputJsonValue },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitAiProposedImport(version.id, document.id);

    expect(result.rowsImported).toBe(2);
    expect(result.sectionsCreated).toBe(2);

    const lineItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    expect(lineItems).toHaveLength(2);
    expect(lineItems.every((li) => li.isDraft)).toBe(true);

    const avItem = lineItems.find((li) => li.description.includes("LED Circular Header"));
    expect(avItem?.unitCost.toNumber()).toBe(31360);
    expect(avItem?.category).toBe("Audio/Visual");

    // qtyIsExplicit: false -- the caveat is appended to the description
    // the same way scope-line-item-service.ts's commit already does.
    const laborItem = lineItems.find((li) => li.description.includes("Rigging labor"));
    expect(laborItem?.description).toContain("(qty estimated -- verify)");
    expect(laborItem?.category).toBe("Labor");
  });

  it("refuses a second commit of the same document into the same version", async () => {
    const { opportunity, document } = await makeDocument();
    await db.category.createMany({ data: [{ name: "Audio/Visual", key: "audio_visual" }, { name: "Labor", key: "labor" }] });
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: FAKE_PROPOSAL as unknown as Prisma.InputJsonValue },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitAiProposedImport(version.id, document.id);

    await expect(commitAiProposedImport(version.id, document.id)).rejects.toThrow(/already been imported/);
  });
});

describe("buildSpreadsheetProposalSchema", () => {
  it("is a strict JSON schema requiring every field this app's citation/commit logic depends on", () => {
    const schema = buildSpreadsheetProposalSchema(["Structure", "Labor"]);
    const itemSchema = schema.schema.properties.items.items;

    expect(schema.strict).toBe(true);
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.required).toEqual([
      "description",
      "qty",
      "qtyIsExplicit",
      "unit",
      "unitCost",
      "unitCostIsExplicit",
      "category",
      "sourceQuote",
      "sheetName",
    ]);
  });
});
