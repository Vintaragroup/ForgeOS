// Proposal generation + approval gate (docs/migration-plan.md Phase 4).
// Kept separate from app/estimates/actions.ts / app/proposals/actions.ts
// the same way estimate-service.ts is kept separate from its own Server
// Action wrappers -- see that file's header comment for why.

import { db } from "@/lib/db";

async function assertLocked(estimateVersionId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
  });
  if (!version.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} must be locked before it can be approved.`);
  }
  return version;
}

// Internal approval gate, distinct from Proposal.sentAt/signedAt below --
// replaces the manual/paper signature process inferred in
// workflow-map.md. Requires the version to already be locked (finalized
// pricing) before it can be approved.
export async function approveEstimateVersion(estimateVersionId: string, approvedById: string) {
  await assertLocked(estimateVersionId);
  return db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: { isApproved: true, approvedAt: new Date(), approvedById },
  });
}

export async function revokeApproval(estimateVersionId: string) {
  return db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: { isApproved: false, approvedAt: null, approvedById: null },
  });
}

// Only a locked AND approved version can generate a Proposal --
// schema.prisma's Proposal comment. templateConfigSnapshot freezes the
// template's current branding/layout so a later template edit doesn't
// retroactively change how an already-generated proposal renders
// (data-model-v0.md's Proposal versioning note).
export async function generateProposal(estimateVersionId: string, templateId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({ where: { id: estimateVersionId } });
  if (!version.isLocked || !version.isApproved) {
    throw new Error(
      `EstimateVersion ${estimateVersionId} must be locked and approved before generating a proposal.`,
    );
  }
  const template = await db.proposalTemplate.findUniqueOrThrow({ where: { id: templateId } });

  return db.proposal.create({
    data: {
      estimateVersionId,
      templateId,
      templateConfigSnapshot: {
        brandingConfig: template.brandingConfig ?? undefined,
        layoutConfig: template.layoutConfig ?? undefined,
      },
    },
  });
}

// Immutable once sent (data-model-v0.md's Proposal versioning note) --
// re-sends create a new Proposal row via generateProposal above rather
// than mutating this one.
export async function sendProposal(proposalId: string) {
  const proposal = await db.proposal.findUniqueOrThrow({ where: { id: proposalId } });
  if (proposal.sentAt) {
    throw new Error(`Proposal ${proposalId} was already sent at ${proposal.sentAt.toISOString()}.`);
  }
  return db.proposal.update({ where: { id: proposalId }, data: { sentAt: new Date() } });
}

// Records that a client signed outside ForgeOS (wet signature, DocuSign,
// etc.) -- a real e-signature vendor integration is out of scope (needs an
// account/API credentials that don't exist yet). This is a typed-name
// attestation instead of a bare timestamp: captures who marked it signed,
// not just when, without pretending it's cryptographically binding.
export async function signProposal(proposalId: string, signedByName: string, signedByTitle?: string | null) {
  if (!signedByName.trim()) {
    throw new Error("A signer name is required.");
  }
  const proposal = await db.proposal.findUniqueOrThrow({ where: { id: proposalId } });
  if (!proposal.sentAt) {
    throw new Error(`Proposal ${proposalId} must be sent before it can be marked signed.`);
  }
  if (proposal.signedAt) {
    throw new Error(`Proposal ${proposalId} was already signed at ${proposal.signedAt.toISOString()}.`);
  }
  return db.proposal.update({
    where: { id: proposalId },
    data: {
      signedAt: new Date(),
      signedByName: signedByName.trim(),
      signedByTitle: signedByTitle?.trim() || null,
    },
  });
}
