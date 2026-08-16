import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { XLSX_MIME } from "@/lib/ai/text-extraction";
import { getObject } from "@/lib/storage";
import {
  assignDocumentEstimate,
  deleteDocument,
  getDocumentBytes,
  listDocuments,
  updateDocumentType,
  uploadDocument,
} from "@/lib/document-service";

// Real fixture from Phase 7's roadmap RFP package -- see data/RFP/superbowl.
// Small (~170KB), so it's fast to round-trip in a test.
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Appendix A - SBLXI - Event Schedule.pdf",
);

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
}

async function makeFile(filePath: string, name: string, type: string) {
  const bytes = await readFile(filePath);
  return new File([bytes], name, { type });
}

describe("uploadDocument / getDocumentBytes / deleteDocument", () => {
  it("stores a real RFP fixture and round-trips it byte-identical", async () => {
    const opportunity = await makeOpportunity();
    const original = await readFile(FIXTURE_PATH);
    const file = await makeFile(FIXTURE_PATH, "Appendix A - Event Schedule.pdf", "application/pdf");

    const document = await uploadDocument(opportunity.id, { file, documentType: "SCHEDULE" });

    expect(document.filename).toBe("Appendix A - Event Schedule.pdf");
    expect(document.documentType).toBe("SCHEDULE");
    expect(document.extractionStatus).toBe("PENDING");
    expect(document.sizeBytes).toBe(original.byteLength);

    const { bytes } = await getDocumentBytes(document.id);
    expect(bytes.equals(original)).toBe(true);

    const listed = await listDocuments(opportunity.id);
    expect(listed.map((d) => d.id)).toContain(document.id);

    await expect(getObject(document.storageKey)).resolves.toBeInstanceOf(Buffer);

    await deleteDocument(opportunity.id, document.id);
    await expect(getObject(document.storageKey)).rejects.toThrow(/not found/i);

    const afterDelete = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(afterDelete.deletedAt).not.toBeNull();

    const listedAfterDelete = await listDocuments(opportunity.id);
    expect(listedAfterDelete.map((d) => d.id)).not.toContain(document.id);
  });

  it("rejects native CAD files with a clear message, not a silent store", async () => {
    const opportunity = await makeOpportunity();
    const file = new File([Buffer.from("not a real dwg")], "booth-plan.dwg", {
      type: "application/octet-stream",
    });

    await expect(uploadDocument(opportunity.id, { file, documentType: "DRAWING" })).rejects.toThrow(
      /Native CAD files/,
    );
  });

  it("rejects files over the upload size limit", async () => {
    const opportunity = await makeOpportunity();
    const oversized = Buffer.alloc(21 * 1024 * 1024);
    const file = new File([oversized], "huge.pdf", { type: "application/pdf" });

    await expect(uploadDocument(opportunity.id, { file, documentType: "OTHER" })).rejects.toThrow(
      /exceeds the 20MB upload limit/,
    );
  });
});

describe("updateDocumentType", () => {
  it("retags a document and resets stale analysis results from the old (wrong) type", async () => {
    const opportunity = await makeOpportunity();
    const file = await makeFile(FIXTURE_PATH, "Financial Proposal Schedule.xlsx", XLSX_MIME);
    const document = await uploadDocument(opportunity.id, { file, documentType: "RFP" });

    // Simulate a real prior (wrong-pipeline) analysis result -- a
    // spreadsheet tagged RFP goes through the text summarizer and comes
    // back UNSUPPORTED, with stale AI fields that shouldn't survive a retag.
    await db.document.update({
      where: { id: document.id },
      data: {
        extractionStatus: "UNSUPPORTED",
        extractedSummary: { eventOrProjectName: null } as unknown as Prisma.InputJsonObject,
        proposedLineItems: [{ description: "stale" }] as unknown as Prisma.InputJsonValue,
      },
    });

    const updated = await updateDocumentType(opportunity.id, document.id, "PRICING_SCHEDULE");

    expect(updated.documentType).toBe("PRICING_SCHEDULE");
    expect(updated.extractionStatus).toBe("PENDING");
    expect(updated.extractedText).toBeNull();
    expect(updated.extractedSummary).toBeNull();
    expect(updated.proposedLineItems).toBeNull();
  });
});

// Regression tests for the cross-resource ID authorization gap: each of
// these mutating functions previously trusted documentId alone, letting
// any caller who already had SOME opportunity's access mutate a document
// belonging to a DIFFERENT opportunity by ID. See each function's own
// header comment in document-service.ts and analyze-document.ts.
describe("opportunity-ownership checks (cross-resource ID authorization)", () => {
  it("deleteDocument rejects a documentId that belongs to a different opportunity", async () => {
    const owner = await makeOpportunity();
    const attacker = await makeOpportunity();
    const file = await makeFile(FIXTURE_PATH, "schedule.pdf", "application/pdf");
    const document = await uploadDocument(owner.id, { file, documentType: "SCHEDULE" });

    await expect(deleteDocument(attacker.id, document.id)).rejects.toThrow();

    const stillThere = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(stillThere.deletedAt).toBeNull();
  });

  it("updateDocumentType rejects a documentId that belongs to a different opportunity", async () => {
    const owner = await makeOpportunity();
    const attacker = await makeOpportunity();
    const file = await makeFile(FIXTURE_PATH, "schedule.pdf", "application/pdf");
    const document = await uploadDocument(owner.id, { file, documentType: "SCHEDULE" });

    await expect(updateDocumentType(attacker.id, document.id, "RFP")).rejects.toThrow();

    const stillThere = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(stillThere.documentType).toBe("SCHEDULE");
  });

  it("assignDocumentEstimate rejects a documentId that belongs to a different opportunity", async () => {
    const owner = await makeOpportunity();
    const attacker = await makeOpportunity();
    const file = await makeFile(FIXTURE_PATH, "schedule.pdf", "application/pdf");
    const document = await uploadDocument(owner.id, { file, documentType: "SCHEDULE" });

    await expect(assignDocumentEstimate(attacker.id, document.id, null)).rejects.toThrow();
  });
});
