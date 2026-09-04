import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import { resetMockCookies } from "@/test/setup";
import { commitImportAction, deleteAndReimportAction } from "./import-actions";

// Same real fixture pricing-import-service.test.ts already uses for its
// own "refuses a second import" coverage of commitPricingImport itself --
// reused here because the bug this file's own test guards against is one
// layer up, in how the ACTION wraps that already-tested throw, not in the
// throw itself.
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Exhibit 1 - SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx",
);

async function makeDocument() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const bytes = await readFile(FIXTURE_PATH);
  const file = new File([bytes], "Exhibit 1 - Financial Proposal Schedule.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const document = await uploadDocument(opportunity.id, { file, documentType: "PRICING_SCHEDULE" });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 0);
  return { opportunity, document, estimate, version };
}

async function makeAdmin() {
  return db.user.create({ data: { name: "Admin", email: `${Math.random()}@test.com`, systemRole: "ADMIN" } });
}

beforeEach(() => {
  resetMockCookies();
});

afterEach(async () => {
  await db.lineItemAuditLog.deleteMany();
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

describe("commitImportAction", () => {
  it("redirects back to the import view with the message, instead of throwing, when the document was already imported", async () => {
    // Regression: commitPricingImport's own "already been imported" guard
    // (pricing-import-service.test.ts's own coverage) used to propagate
    // straight out of this server action uncaught -- Next.js treats an
    // action that throws as an unhandled render error and replaces the
    // whole page with its generic error screen. Confirmed live: a
    // production user re-clicked "Import line items" on a document
    // already committed to this estimate and landed on a dead-end error
    // page instead of a message they could act on.
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { document, estimate, version } = await makeDocument();

    // First import succeeds and commits real rows -- still redirects
    // (Next's real redirect() throws even on the success path), so it's
    // awaited via .catch() the same way the second, failing call is below.
    await commitImportAction(estimate.id, version.id, document.id, new FormData()).catch(() => {});
    const firstImportCount = await db.lineItem.count({ where: { documentId: document.id } });
    expect(firstImportCount).toBeGreaterThan(0);

    // Second import of the exact same document hits the guard -- this
    // must redirect with the error message, not throw the raw Error.
    // Next.js's real redirect() throws an object carrying the target URL
    // as `digest` (see bid-package-actions.test.ts's own comment on this
    // same pattern), so a caught redirect is what "handled, not crashed"
    // looks like from a test's perspective.
    const rejection = (await commitImportAction(estimate.id, version.id, document.id, new FormData()).catch(
      (err: unknown) => err,
    )) as { digest?: string };
    expect(rejection.digest).toContain("commitImportError=");
    expect(rejection.digest).toContain(encodeURIComponent("has already been imported"));
    expect(rejection.digest).toContain(`importDocumentId=${document.id}`);
    // AlreadyImportedError specifically -- this is what gates page.tsx's
    // "Delete & re-import" button (see commitImportAction's own comment on
    // why "no rows found" and similar rejections must NOT set this).
    expect(rejection.digest).toContain("canDeleteAndReimport=1");

    // The guard rejects before touching the DB again -- no duplicate rows.
    const finalCount = await db.lineItem.count({ where: { documentId: document.id } });
    expect(finalCount).toBe(firstImportCount);
  });
});

describe("deleteAndReimportAction", () => {
  it("deletes the document's existing rows and successfully re-imports it in one action", async () => {
    // This is exactly the recovery path the "Delete & re-import" button
    // above offers a user who hits AlreadyImportedError -- confirmed live
    // as a real ask: a user who'd already deleted a whole category's line
    // items by hand asked for this to be one click instead of a
    // delete-then-separately-retry dance.
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { document, estimate, version } = await makeDocument();

    await commitImportAction(estimate.id, version.id, document.id, new FormData()).catch(() => {});
    const firstImportCount = await db.lineItem.count({ where: { documentId: document.id } });
    expect(firstImportCount).toBeGreaterThan(0);
    const firstImportIds = new Set(
      (await db.lineItem.findMany({ where: { documentId: document.id }, select: { id: true } })).map((li) => li.id),
    );

    await deleteAndReimportAction(estimate.id, version.id, document.id, new FormData()).catch((err: unknown) => {
      // A success redirect throws too (Next's real redirect()) -- only
      // fail the test if this was actually a commitImportError redirect.
      const digest = (err as { digest?: string }).digest;
      if (digest?.includes("commitImportError=")) throw err;
    });

    const finalItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    expect(finalItems.length).toBe(firstImportCount);
    // Freshly re-created rows, not the original ones left in place --
    // proves the delete step actually ran before the re-import, not just
    // a no-op commit on top of the untouched originals.
    expect(finalItems.every((li) => !firstImportIds.has(li.id))).toBe(true);
  });
});
