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
  await db.project.deleteMany();
  await db.stageChangeEvent.deleteMany();
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

describe("signProposal -- production handoff trigger", () => {
  async function makeSentProposal(label?: string) {
    const { version, user } = await makeLockedVersion(label);
    await approveEstimateVersion(version.id, user.id);
    const template = await db.proposalTemplate.create({ data: { name: `Standard-${label ?? "Structure"}` } });
    const proposal = await generateProposal(version.id, template.id);
    await sendProposal(proposal.id);
    const opportunity = await db.opportunity.findFirstOrThrow({
      where: { estimates: { some: { versions: { some: { id: version.id } } } } },
    });
    return { proposal, opportunity };
  }

  it("advances the opportunity to WON and creates exactly one Project", async () => {
    const { proposal, opportunity } = await makeSentProposal();
    expect(opportunity.stage).toBe("NEW"); // sanity check: not already WON before signing (fixture never sets a stage, default is NEW)

    await signProposal(proposal.id, "Jane Doe", "Owner");

    const reloaded = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(reloaded.stage).toBe("WON");

    const stageChange = await db.stageChangeEvent.findFirst({ where: { opportunityId: opportunity.id, toStage: "WON" } });
    expect(stageChange).not.toBeNull();
    expect(stageChange?.note).toMatch(/proposal signed/i);

    const projects = await db.project.findMany({ where: { opportunityId: opportunity.id } });
    expect(projects).toHaveLength(1);
  });

  it("does not re-advance stage or duplicate the StageChangeEvent if the opportunity is already WON", async () => {
    const { proposal, opportunity } = await makeSentProposal();
    await db.opportunity.update({ where: { id: opportunity.id }, data: { stage: "WON" } });

    await signProposal(proposal.id, "Jane Doe");

    const stageChanges = await db.stageChangeEvent.findMany({ where: { opportunityId: opportunity.id, toStage: "WON" } });
    expect(stageChanges).toHaveLength(0); // already WON -- signProposal's guard should skip the transition entirely

    const projects = await db.project.findMany({ where: { opportunityId: opportunity.id } });
    expect(projects).toHaveLength(1); // still converts to a Project even though stage didn't need to change
  });

  it("signing a second proposal for the same opportunity does not create a second Project", async () => {
    const { proposal, opportunity } = await makeSentProposal();
    await signProposal(proposal.id, "Jane Doe");

    // A second Estimate/EstimateVersion/Proposal on the SAME opportunity --
    // e.g. two separate exhibits for one client -- see project-service.ts's
    // own comment on why Project has no direct FK to Estimate.
    const estimate2 = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version2 = await createEstimateVersion(estimate2.id, 0);
    const section2 = await addSection(version2.id, { name: "COMPONENT 2", sectionType: "COMPONENT" });
    const category2 = await db.category.create({ data: { name: "Second Exhibit Cat", key: "second-exhibit-cat" } });
    await addLineItem(version2.id, section2.id, {
      lineType: "MATERIAL",
      description: "Aluminum",
      qty: 5,
      unitCost: 10,
      category: category2.name,
    });
    await lockEstimateVersion(version2.id);
    const approver2 = await db.user.create({ data: { name: "Second Approver", email: `approver2-${Date.now()}@example.com` } });
    await approveEstimateVersion(version2.id, approver2.id);
    const template2 = await db.proposalTemplate.create({ data: { name: "Standard 2" } });
    const proposal2 = await generateProposal(version2.id, template2.id);
    await sendProposal(proposal2.id);

    await signProposal(proposal2.id, "John Smith");

    const projects = await db.project.findMany({ where: { opportunityId: opportunity.id } });
    expect(projects).toHaveLength(1);
  });
});
