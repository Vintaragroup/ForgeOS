import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createArtworkOrder } from "@/lib/artwork-order-service";
import { createAnnotation, resolveAnnotation, listAnnotationsForViewer } from "@/lib/artwork-annotation-service";

afterEach(async () => {
  await db.artworkAnnotation.deleteMany();
  await db.artworkFile.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

// No real bytes/storage needed for these tests -- create/resolve/list never
// touch storage, only the ArtworkAnnotation table, so a real ArtworkFile row
// with a throwaway storageKey is enough to attach annotations to.
async function makeArtworkFile() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const order = await createArtworkOrder(opportunity.id);
  return db.artworkFile.create({
    data: {
      artworkOrderId: order.id,
      kind: "PROOF",
      filename: "proof-round-1.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: `${order.id}/proof-round-1.pdf`,
      uploadedByType: "VENDOR",
      uploadedByEmail: "vendor@example.com",
    },
  });
}

describe("createAnnotation", () => {
  it("creates a pin with the EXPO actor's userId, not an email", async () => {
    const file = await makeArtworkFile();
    const annotation = await createAnnotation(
      file.id,
      { xPct: 0.5, yPct: 0.25, note: "Move the logo here" },
      { type: "EXPO", userId: "user-1" },
    );
    expect(annotation.authorType).toBe("EXPO");
    expect(annotation.authorUserId).toBe("user-1");
    expect(annotation.authorEmail).toBeNull();
    expect(annotation.note).toBe("Move the logo here");
    expect(annotation.resolvedAt).toBeNull();
  });

  it("creates a pin with the CLIENT actor's email, not a userId", async () => {
    const file = await makeArtworkFile();
    const annotation = await createAnnotation(
      file.id,
      { xPct: 0.1, yPct: 0.9, note: "This should be bigger" },
      { type: "CLIENT", email: "client@example.com" },
    );
    expect(annotation.authorType).toBe("CLIENT");
    expect(annotation.authorEmail).toBe("client@example.com");
    expect(annotation.authorUserId).toBeNull();
  });

  it("rejects a pin position outside the image", async () => {
    const file = await makeArtworkFile();
    await expect(
      createAnnotation(file.id, { xPct: 1.5, yPct: 0.5, note: "Out of bounds" }, { type: "EXPO", userId: "u1" }),
    ).rejects.toThrow(/within the image/);
  });

  it("rejects an empty note", async () => {
    const file = await makeArtworkFile();
    await expect(
      createAnnotation(file.id, { xPct: 0.5, yPct: 0.5, note: "   " }, { type: "EXPO", userId: "u1" }),
    ).rejects.toThrow(/note is required/);
  });
});

describe("resolveAnnotation", () => {
  it("sets resolvedAt and resolvedByUserId", async () => {
    const file = await makeArtworkFile();
    const annotation = await createAnnotation(file.id, { xPct: 0.5, yPct: 0.5, note: "Fix this" }, { type: "EXPO", userId: "u1" });
    const resolved = await resolveAnnotation(annotation.id, "resolver-1");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedByUserId).toBe("resolver-1");
  });
});

describe("listAnnotationsForViewer", () => {
  it("includes authorType when not anonymized", async () => {
    const file = await makeArtworkFile();
    await createAnnotation(file.id, { xPct: 0.2, yPct: 0.2, note: "Note 1" }, { type: "EXPO", userId: "u1" });
    const rows = await listAnnotationsForViewer(file.id, { anonymize: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].authorType).toBe("EXPO");
  });

  it("omits every author field at the query level when anonymized -- not just hidden in the UI", async () => {
    const file = await makeArtworkFile();
    await createAnnotation(file.id, { xPct: 0.3, yPct: 0.3, note: "Note 2" }, { type: "CLIENT", email: "client@example.com" });
    const rows = await listAnnotationsForViewer(file.id, { anonymize: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].authorType).toBeUndefined();
    expect("authorUserId" in rows[0]).toBe(false);
    expect("authorEmail" in rows[0]).toBe(false);
    // The content itself (what a vendor SHOULD see) is still there.
    expect(rows[0].note).toBe("Note 2");
    expect(rows[0].xPct).toBe(0.3);
  });

  it("orders pins chronologically so numbering stays stable", async () => {
    const file = await makeArtworkFile();
    const first = await createAnnotation(file.id, { xPct: 0.1, yPct: 0.1, note: "First" }, { type: "EXPO", userId: "u1" });
    const second = await createAnnotation(file.id, { xPct: 0.2, yPct: 0.2, note: "Second" }, { type: "EXPO", userId: "u1" });
    const rows = await listAnnotationsForViewer(file.id, { anonymize: false });
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
  });
});
