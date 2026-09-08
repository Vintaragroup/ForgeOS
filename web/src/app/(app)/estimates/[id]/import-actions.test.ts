import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import type { ProposedLineItem } from "@/lib/ai/scope-line-item-service";
import { resetMockCookies } from "@/test/setup";
import { commitImportAction, commitScopeItemsAction, commitSelectedScopeItemsAction, deleteAndReimportAction } from "./import-actions";

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

async function makeProposedScopeDocument(proposed: ProposedLineItem[]) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const document = await db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "Scope of Work.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "SCOPE_OF_WORK",
      extractionStatus: "COMPLETE",
      extractedText: "some scope text",
      proposedLineItems: proposed as unknown as Prisma.InputJsonValue,
    },
  });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 0);
  return { opportunity, document, estimate, version };
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
  // Replaces this describe block's old "redirects back to the import view
  // with the message, instead of throwing, when the document was already
  // imported" test -- commitPricingImport's own flat-schedule "already
  // been imported" guard (pricing-import-service.test.ts's own coverage)
  // is gone, replaced by fresh Tier 1 exact-match detection that silently
  // excludes a duplicate instead of throwing, so a second import of the
  // same document now succeeds normally through this action rather than
  // redirecting with an error.
  it("succeeds normally (redirecting to the plain documents tab, no error) on a second import of the same document, committing zero new rows", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const { document, estimate, version } = await makeDocument();

    // First import succeeds and commits real rows -- still redirects
    // (Next's real redirect() throws even on the success path), so it's
    // awaited via .catch() the same way the second call is below.
    await commitImportAction(estimate.id, version.id, document.id, new FormData()).catch(() => {});
    const firstImportCount = await db.lineItem.count({ where: { documentId: document.id } });
    expect(firstImportCount).toBeGreaterThan(0);

    const secondRedirect = (await commitImportAction(estimate.id, version.id, document.id, new FormData()).catch(
      (err: unknown) => err,
    )) as { digest?: string };
    // A plain success redirect (?tab=documents, no commitImportError param)
    // -- not the old error-redirect this test used to assert.
    expect(secondRedirect.digest).toContain(`/estimates/${estimate.id}?tab=documents`);
    expect(secondRedirect.digest).not.toContain("commitImportError=");

    const secondImportCount = await db.lineItem.count({ where: { documentId: document.id } });
    expect(secondImportCount).toBe(firstImportCount); // nothing duplicated
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

describe("commitScopeItemsAction", () => {
  it("redirects back to the propose view with the message, instead of throwing, on a business-rule rejection", async () => {
    // Regression: this action previously had NO try/catch at all --
    // commitScopeLineItems's own "click Propose items first" rejection
    // (or any other) propagated straight out uncaught, same class of bug
    // commitImportAction's own try/catch already fixed for the pricing-
    // import path (see that describe block's own comment).
    const admin = await makeAdmin();
    await createSession(admin.id);
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Scope of Work.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "SCOPE_OF_WORK",
        extractionStatus: "COMPLETE",
        extractedText: "some scope text",
      },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const rejection = (await commitScopeItemsAction(estimate.id, version.id, document.id).catch(
      (err: unknown) => err,
    )) as { digest?: string };
    expect(rejection.digest).toContain("commitScopeError=");
    expect(rejection.digest).toContain(encodeURIComponent("Propose items first"));
    expect(rejection.digest).toContain(`proposeDocumentId=${document.id}`);
  });
});

describe("commitSelectedScopeItemsAction", () => {
  it("returns a plain rowsImported result and forwards indices correctly, committing only the explicitly selected rows", async () => {
    const admin = await makeAdmin();
    await createSession(admin.id);
    const proposed: ProposedLineItem[] = [
      {
        description: "Booth walls",
        qty: 1,
        qtyIsExplicit: true,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
      {
        description: "Graphics production",
        qty: 1,
        qtyIsExplicit: true,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Countertops & Cable Management",
        sourceQuote: "some scope text",
      },
    ];
    const { document, estimate, version } = await makeProposedScopeDocument(proposed);

    const result = await commitSelectedScopeItemsAction(estimate.id, version.id, document.id, [0]);

    expect(result).toEqual({ rowsImported: 1 });
    const items = await db.lineItem.findMany({ where: { section: { estimateVersionId: version.id } } });
    expect(items.map((i) => i.description)).toEqual(["Booth walls"]);
  });
});
