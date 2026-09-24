import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { decideRecostProposal } from "@/lib/recost-apply-service";
import { recomputeVersionTotals, restoreLineItem } from "@/lib/estimate-service";

let opportunityId = "";
let versionId = "";
let lockedVersionId = "";
let sectionId = "";
let lineItemId = "";
let documentId = "";
let userId = "";

async function makeProposal(over: Record<string, unknown> = {}) {
  return db.recostProposal.create({
    data: {
      estimateVersionId: versionId,
      lineItemId,
      action: "REMOVE",
      reason: "gone from the revised drawing",
      sourceDocumentId: documentId,
      sourceQuote: "The front structure with monitors and LED elements is no longer present.",
      confidence: "NEED_YOUR_DECISION",
      ...over,
    },
  });
}

beforeEach(async () => {
  const user = await db.user.create({
    data: { email: "estimator@test.com", name: "Estimator", systemRole: "EMPLOYEE" },
  });
  userId = user.id;
  const company = await db.company.create({ data: { name: "Full Swing" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "ABCA Chicago", stage: "ESTIMATING" },
  });
  opportunityId = opportunity.id;
  const estimate = await db.estimate.create({ data: { opportunityId } });
  const locked = await db.estimateVersion.create({
    data: { estimateId: estimate.id, versionNumber: 1, isLocked: true },
  });
  lockedVersionId = locked.id;
  const version = await db.estimateVersion.create({
    data: { estimateId: estimate.id, versionNumber: 2, isLocked: false },
  });
  versionId = version.id;
  const section = await db.estimateSection.create({
    data: {
      estimateVersionId: version.id,
      name: "Reception Counter",
      groupLabel: "FS - Reception Counter",
      boothDescription: "Reception counter, client-facing",
      sortOrder: 3,
      sectionType: "COMPONENT",
    },
  });
  sectionId = section.id;
  const lineItem = await db.lineItem.create({
    data: {
      sectionId: section.id,
      lineType: "MATERIAL",
      description: "Reception counter carcass",
      qty: 1,
      unitCost: 5000,
      totalCost: 5000,
      sortOrder: 1,
    },
  });
  lineItemId = lineItem.id;
  const document = await db.document.create({
    data: {
      opportunityId,
      filename: "REVISED.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      storageKey: "k",
      documentType: "DRAWING",
    },
  });
  documentId = document.id;
});

afterEach(async () => {
  await db.recostProposal.deleteMany();
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

describe("decideRecostProposal", () => {
  it("removes the line item and records it as applied", async () => {
    const proposal = await makeProposal();
    const out = await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

    expect(out.status).toBe("APPLIED");
    expect(out.changedLineItems).toBe(1);
    expect(await db.lineItem.count({ where: { id: lineItemId } })).toBe(0);

    const stored = await db.recostProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.status).toBe("APPLIED");
    expect(stored.decidedById).toBe(userId);
    expect(stored.decidedAt).not.toBeNull();
  });

  // Goes through deleteLineItem rather than touching rows, which is what
  // gets the audit entry and the snapshot that makes it restorable.
  it("leaves an audit trail with a way back", async () => {
    const proposal = await makeProposal();
    await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

    const audit = await db.lineItemAuditLog.findMany({ where: { estimateVersionId: versionId } });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("DELETE");
    expect(audit[0].description).toBe("Reception counter carcass");
    expect(audit[0].actorId).toBe(userId);
    // The snapshot is what restoreLineItem reads.
    expect(audit[0].detail).not.toBeNull();
  });

  it("writes a price a reprice carries", async () => {
    const proposal = await makeProposal({ action: "REPRICE", newUnitCost: 1300 });
    const out = await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

    expect(out.status).toBe("APPLIED");
    const item = await db.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
    expect(item.unitCost.toNumber()).toBe(1300);
    expect(item.totalCost.toNumber()).toBe(1300);
  });

  // The most common real outcome, and it is not "done". "The hanging
  // sign now displays additional text" is a genuine agreed finding with
  // nothing to apply until somebody prices the revised sign.
  it("records a decision that has nothing to apply as accepted, not applied", async () => {
    const proposal = await makeProposal({ action: "NEEDS_QUOTE" });
    const out = await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

    expect(out.status).toBe("ACCEPTED");
    expect(out.changedLineItems).toBe(0);
    expect(out.effect).toHaveProperty("why", expect.stringContaining("needs a quote"));
    // Nothing moved, and nothing pretended to.
    expect(await db.lineItem.count({ where: { id: lineItemId } })).toBe(1);
    expect(await db.lineItemAuditLog.count()).toBe(0);
  });

  it("records a rejection without touching the estimate", async () => {
    const proposal = await makeProposal();
    const out = await decideRecostProposal(proposal.id, opportunityId, userId, "REJECT");

    expect(out.status).toBe("REJECTED");
    expect(await db.lineItem.count({ where: { id: lineItemId } })).toBe(1);
    const stored = await db.recostProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.decidedById).toBe(userId);
  });

  // A second click on a stale screen would otherwise re-delete a line
  // item that has already gone.
  it("refuses to decide the same proposal twice", async () => {
    const proposal = await makeProposal();
    await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

    await expect(decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT")).rejects.toThrow(
      /already applied/i,
    );
  });

  // v1 is what the client received.
  it("refuses to touch a locked version", async () => {
    const proposal = await makeProposal({ estimateVersionId: lockedVersionId, lineItemId: null, sectionId: null });
    await expect(decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT")).rejects.toThrow(/locked/i);
  });

  // A proposal id from another client's estimate must not resolve here.
  it("refuses a proposal that belongs to a different opportunity", async () => {
    const proposal = await makeProposal();
    const other = await db.company.create({ data: { name: "Someone Else" } });
    const otherOpportunity = await db.opportunity.create({
      data: { companyId: other.id, showName: "Other", stage: "ESTIMATING" },
    });

    await expect(
      decideRecostProposal(proposal.id, otherOpportunity.id, userId, "ACCEPT"),
    ).rejects.toThrow(/no longer on this estimate/i);
    expect(await db.lineItem.count({ where: { id: lineItemId } })).toBe(1);
  });

  // The audit the estimator asked for before letting this touch a live
  // job: applying a proposal must not disturb the structure around it.
  // The fear is well earned -- createNewVersionFromLocked once blew out
  // every booth grouping and description on this exact estimate.
  describe("blast radius", () => {
    it("leaves the section and its groupings completely untouched", async () => {
      const before = await db.estimateSection.findUniqueOrThrow({ where: { id: sectionId } });
      const proposal = await makeProposal();

      await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

      const after = await db.estimateSection.findUniqueOrThrow({ where: { id: sectionId } });
      // Every field, not a hand-picked few: a future field added to
      // EstimateSection is covered by this without anyone remembering to
      // add it here.
      expect(after).toEqual(before);
    });

    it("keeps an emptied section alive so its heading does not vanish", async () => {
      const proposal = await makeProposal({ lineItemId: null, sectionId });
      await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

      const section = await db.estimateSection.findUnique({ where: { id: sectionId } });
      expect(section).not.toBeNull();
      expect(section!.groupLabel).toBe("FS - Reception Counter");
      expect(section!.boothDescription).toBe("Reception counter, client-facing");
      expect(section!.sortOrder).toBe(3);
    });

    it("touches no other line item in the version", async () => {
      const sibling = await db.lineItem.create({
        data: {
          sectionId,
          lineType: "LABOR",
          description: "Counter install",
          qty: 4,
          unitCost: 100,
          totalCost: 400,
          sortOrder: 2,
        },
      });
      const otherSection = await db.estimateSection.create({
        data: { estimateVersionId: versionId, name: "Hitting Bay", groupLabel: "FS - Hitting Bay", sectionType: "COMPONENT" },
      });
      const elsewhere = await db.lineItem.create({
        data: { sectionId: otherSection.id, lineType: "MATERIAL", description: "Wall panel", qty: 1, unitCost: 900, totalCost: 900 },
      });

      const proposal = await makeProposal();
      await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

      expect(await db.lineItem.findUnique({ where: { id: sibling.id } })).toEqual(sibling);
      expect(await db.lineItem.findUnique({ where: { id: elsewhere.id } })).toEqual(elsewhere);
      expect(await db.estimateSection.findUnique({ where: { id: otherSection.id } })).not.toBeNull();
    });

    it("changes only the money when repricing, never where the item sits", async () => {
      const before = await db.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
      const proposal = await makeProposal({ action: "REPRICE", newUnitCost: 1300 });

      await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

      const after = await db.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
      expect(after.unitCost.toNumber()).toBe(1300);
      expect(after.totalCost.toNumber()).toBe(1300);
      // Everything that decides where it appears and what it is called.
      expect(after.sectionId).toBe(before.sectionId);
      expect(after.sortOrder).toBe(before.sortOrder);
      expect(after.description).toBe(before.description);
      expect(after.subgroupLabel).toBe(before.subgroupLabel);
      expect(after.category).toBe(before.category);
      expect(after.lineType).toBe(before.lineType);
      expect(after.qty.toNumber()).toBe(before.qty.toNumber());
    });

    it("records a reprice as before-and-after so the change is readable", async () => {
      const proposal = await makeProposal({ action: "REPRICE", newUnitCost: 1300 });
      await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

      const audit = await db.lineItemAuditLog.findFirstOrThrow({ where: { action: "UPDATE" } });
      const detail = audit.detail as Record<string, { before: unknown; after: unknown }>;
      expect(detail.unitCost).toEqual({ before: "5000", after: "1300" });
      expect(detail.totalCost).toEqual({ before: "5000", after: "1300" });
      // Nothing else claimed to have changed.
      expect(Object.keys(detail).sort()).toEqual(["totalCost", "unitCost"]);
    });

    // The whole point of the snapshot: a removal is undoable, and it
    // comes back where it was rather than into a recovery bucket.
    it("restores a removed item to its original section and position", async () => {
      const before = await db.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
      const proposal = await makeProposal();
      await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");

      const audit = await db.lineItemAuditLog.findFirstOrThrow({ where: { action: "DELETE" } });
      await restoreLineItem(opportunityId, audit.id, userId);

      const restored = await db.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
      expect(restored.sectionId).toBe(before.sectionId);
      expect(restored.sortOrder).toBe(before.sortOrder);
      expect(restored.description).toBe(before.description);
      expect(restored.unitCost.toNumber()).toBe(before.unitCost.toNumber());
      expect(restored.totalCost.toNumber()).toBe(before.totalCost.toNumber());
    });

    it("keeps the version total honest on the way out and back", async () => {
      const proposal = await makeProposal();
      await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");
      const afterRemoval = await db.estimateVersion.findUniqueOrThrow({ where: { id: versionId } });
      expect(afterRemoval.totalCost.toNumber()).toBe(0);

      const audit = await db.lineItemAuditLog.findFirstOrThrow({ where: { action: "DELETE" } });
      await restoreLineItem(opportunityId, audit.id, userId);
      // restoreLineItem does not recompute -- the convention in
      // estimate-service is that mutators mutate and the caller totals
      // up, so bulk paths pay for one recompute instead of N.
      // restoreLineItemAction does exactly this, and this line is the
      // caller standing in for it.
      await recomputeVersionTotals(versionId);
      const afterRestore = await db.estimateVersion.findUniqueOrThrow({ where: { id: versionId } });
      expect(afterRestore.totalCost.toNumber()).toBe(5000);
    });
  });

  // How an estimator thinks about "the reception counter" -- one thing.
  // Deleted one at a time so each row keeps its own way back.
  it("removes every line item in a section, each with its own audit row", async () => {
    await db.lineItem.create({
      data: {
        sectionId,
        lineType: "LABOR",
        description: "Reception counter install",
        qty: 4,
        unitCost: 100,
        totalCost: 400,
      },
    });
    const proposal = await makeProposal({ lineItemId: null, sectionId });

    const out = await decideRecostProposal(proposal.id, opportunityId, userId, "ACCEPT");
    expect(out.changedLineItems).toBe(2);
    expect(await db.lineItem.count({ where: { sectionId } })).toBe(0);
    expect(await db.lineItemAuditLog.count({ where: { action: "DELETE" } })).toBe(2);
  });
});
