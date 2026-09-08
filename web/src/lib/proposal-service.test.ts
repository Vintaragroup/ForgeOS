import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLineItem, addSection, createEstimateVersion, createNewVersionFromLocked, lockEstimateVersion } from "@/lib/estimate-service";
import {
  approveEstimateVersion,
  generateProposal,
  revokeApproval,
  sendProposal,
  signProposal,
} from "@/lib/proposal-service";

afterEach(async () => {
  await db.proposal.deleteMany();
  await db.proposalTemplate.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
  await db.category.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeLockedVersion(label = "Structure") {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show" },
  });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 50);
  const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
  // sendProposal (proposal-service.ts) hard-blocks on an unresolved
  // category (see category-audit.ts), so this fixture needs a real,
  // matching Category row -- forgeos_test has no seeded categories.
  // Category.name/key are both unique, so a test calling this fixture more
  // than once for two genuinely unrelated estimates needs a distinct label.
  const category = await db.category.create({ data: { name: label, key: label.toLowerCase() } });
  await addLineItem(version.id, section.id, {
    lineType: "MATERIAL",
    description: "Plywood",
    qty: 10,
    unitCost: 20,
    category: category.name,
  });
  await lockEstimateVersion(version.id);
  const user = await db.user.create({ data: { name: "Test Approver", email: `approver-${Date.now()}@example.com` } });
  return { version, user };
}

describe("approveEstimateVersion", () => {
  it("approves a locked version", async () => {
    const { version, user } = await makeLockedVersion();
    const approved = await approveEstimateVersion(version.id, user.id);
    expect(approved.isApproved).toBe(true);
    expect(approved.approvedById).toBe(user.id);
    expect(approved.approvedAt).not.toBeNull();
  });

  it("rejects approving an unlocked version", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Show" } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    const user = await db.user.create({ data: { name: "Approver", email: `a-${Date.now()}@example.com` } });

    await expect(approveEstimateVersion(version.id, user.id)).rejects.toThrow(/locked/);
  });

  it("revokeApproval clears the approval fields", async () => {
    const { version, user } = await makeLockedVersion();
    await approveEstimateVersion(version.id, user.id);
    const revoked = await revokeApproval(version.id);
    expect(revoked.isApproved).toBe(false);
    expect(revoked.approvedById).toBeNull();
    expect(revoked.approvedAt).toBeNull();
  });

  it("rejects a different person approving a later version of the same estimate", async () => {
    const { version: v1, user: originalApprover } = await makeLockedVersion();
    await approveEstimateVersion(v1.id, originalApprover.id);
    const v2 = await createNewVersionFromLocked(v1.id);
    await lockEstimateVersion(v2.id);
    const someoneElse = await db.user.create({ data: { name: "A Different Person", email: `diff-${Date.now()}@example.com` } });

    await expect(approveEstimateVersion(v2.id, someoneElse.id)).rejects.toThrow(/only they can approve/);
    await expect(approveEstimateVersion(v2.id, someoneElse.id)).rejects.toThrow(/Test Approver/);
  });

  it("allows the same original approver to approve a later version of the same estimate", async () => {
    const { version: v1, user: originalApprover } = await makeLockedVersion();
    await approveEstimateVersion(v1.id, originalApprover.id);
    const v2 = await createNewVersionFromLocked(v1.id);
    await lockEstimateVersion(v2.id);

    const approved = await approveEstimateVersion(v2.id, originalApprover.id);
    expect(approved.isApproved).toBe(true);
    expect(approved.approvedById).toBe(originalApprover.id);
  });

  it("imposes no restriction on the very first approval of a brand-new estimate", async () => {
    // makeLockedVersion's own "approves a locked version" test above
    // already covers this implicitly, but spelled out explicitly here:
    // there's no PRIOR approved version to match against yet, so any
    // authorized user can make that first call.
    const { version, user } = await makeLockedVersion();
    await expect(approveEstimateVersion(version.id, user.id)).resolves.toMatchObject({ approvedById: user.id });
  });

  it("does not restrict approval on an unrelated estimate that happens to share nothing but a different approver", async () => {
    const { version: v1, user: approverA } = await makeLockedVersion();
    await approveEstimateVersion(v1.id, approverA.id);

    // A second, wholly unrelated estimate -- not a new version of v1's
    // estimate -- must not be affected by v1's own approver.
    const { version: unrelatedVersion, user: approverB } = await makeLockedVersion("Furniture");
    await expect(approveEstimateVersion(unrelatedVersion.id, approverB.id)).resolves.toMatchObject({
      approvedById: approverB.id,
    });
  });
});

describe("generateProposal", () => {
  it("rejects generating from a locked-but-unapproved version", async () => {
    const { version } = await makeLockedVersion();
    const template = await db.proposalTemplate.create({ data: { name: "Standard" } });
    await expect(generateProposal(version.id, template.id)).rejects.toThrow(/locked and approved/);
  });

  it("generates a proposal from a locked and approved version, snapshotting the template", async () => {
    const { version, user } = await makeLockedVersion();
    await approveEstimateVersion(version.id, user.id);
    const template = await db.proposalTemplate.create({
      data: { name: "Standard", brandingConfig: { color: "blue" } },
    });

    const proposal = await generateProposal(version.id, template.id);
    expect(proposal.estimateVersionId).toBe(version.id);
    expect(proposal.templateId).toBe(template.id);
    expect(proposal.sentAt).toBeNull();
    expect(proposal.templateConfigSnapshot).toMatchObject({ brandingConfig: { color: "blue" } });
  });

  it("a later template edit does not change an already-generated proposal's snapshot", async () => {
    const { version, user } = await makeLockedVersion();
    await approveEstimateVersion(version.id, user.id);
    const template = await db.proposalTemplate.create({
      data: { name: "Standard", brandingConfig: { color: "blue" } },
    });
    const proposal = await generateProposal(version.id, template.id);

    await db.proposalTemplate.update({ where: { id: template.id }, data: { brandingConfig: { color: "red" } } });

    const reloaded = await db.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(reloaded.templateConfigSnapshot).toMatchObject({ brandingConfig: { color: "blue" } });
  });
});

describe("send / sign lifecycle", () => {
  it("sends then signs a proposal in order", async () => {
    const { version, user } = await makeLockedVersion();
    await approveEstimateVersion(version.id, user.id);
    const template = await db.proposalTemplate.create({ data: { name: "Standard" } });
    const proposal = await generateProposal(version.id, template.id);

    const sent = await sendProposal(proposal.id);
    expect(sent.sentAt).not.toBeNull();

    const signed = await signProposal(proposal.id, "Jane Doe", "Owner");
    expect(signed.signedAt).not.toBeNull();
    expect(signed.signedByName).toBe("Jane Doe");
    expect(signed.signedByTitle).toBe("Owner");
  });

  it("rejects signing before sending", async () => {
    const { version, user } = await makeLockedVersion();
    await approveEstimateVersion(version.id, user.id);
    const template = await db.proposalTemplate.create({ data: { name: "Standard" } });
    const proposal = await generateProposal(version.id, template.id);

    await expect(signProposal(proposal.id, "Jane Doe")).rejects.toThrow(/must be sent/);
  });

  it("rejects sending the same proposal twice", async () => {
    const { version, user } = await makeLockedVersion();
    await approveEstimateVersion(version.id, user.id);
    const template = await db.proposalTemplate.create({ data: { name: "Standard" } });
    const proposal = await generateProposal(version.id, template.id);
    await sendProposal(proposal.id);

    await expect(sendProposal(proposal.id)).rejects.toThrow(/already sent/);
  });
});
