import { createElement } from "react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { renderToBuffer, Document, Page } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { putObject } from "@/lib/storage";
import { finalizeArtworkUpload } from "@/lib/artwork-file-service";
import { createArtworkOrder } from "@/lib/artwork-order-service";

afterEach(async () => {
  await db.artworkFile.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeArtworkOrder() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return createArtworkOrder(opportunity.id);
}

async function makeValidPdf(): Promise<Buffer> {
  return renderToBuffer(createElement(Document, null, createElement(Page, { size: [360, 360] })));
}

describe("finalizeArtworkUpload -- previewable check", () => {
  it("sets previewable true for a real, parseable PDF", async () => {
    const order = await makeArtworkOrder();
    const storageKey = `${order.id}/artwork.pdf`;
    await putObject(storageKey, await makeValidPdf());

    const file = await finalizeArtworkUpload(order.id, {
      storageKey,
      kind: "CLIENT_ARTWORK",
      round: 0,
      originalFilename: "artwork.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      uploadedByType: "CLIENT",
      uploadedByEmail: "client@example.com",
    });

    expect(file.previewable).toBe(true);
  });

  it("sets previewable false for bytes that aren't a real PDF -- e.g. a genuine (non-PDF-compatible) .ai file", async () => {
    const order = await makeArtworkOrder();
    const storageKey = `${order.id}/artwork.ai`;
    await putObject(storageKey, Buffer.from("%!PS-Adobe-3.0 this is not actually a PDF stream"));

    const file = await finalizeArtworkUpload(order.id, {
      storageKey,
      kind: "CLIENT_ARTWORK",
      round: 0,
      originalFilename: "artwork.ai",
      mimeType: "", // browsers routinely report no mimeType at all for .ai
      sizeBytes: 100,
      uploadedByType: "CLIENT",
      uploadedByEmail: "client@example.com",
    });

    expect(file.previewable).toBe(false);
  });

  it("sets previewable false rather than throwing when the storage object is missing entirely", async () => {
    const order = await makeArtworkOrder();
    const file = await finalizeArtworkUpload(order.id, {
      storageKey: `${order.id}/never-uploaded.pdf`,
      kind: "CLIENT_ARTWORK",
      round: 0,
      originalFilename: "artwork.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      uploadedByType: "CLIENT",
      uploadedByEmail: "client@example.com",
    });

    expect(file.previewable).toBe(false);
  });
});
