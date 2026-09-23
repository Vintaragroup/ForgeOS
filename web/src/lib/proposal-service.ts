// Proposal generation + approval gate (docs/migration-plan.md Phase 4).
// Kept separate from app/estimates/actions.ts / app/proposals/actions.ts
// the same way estimate-service.ts is kept separate from its own Server
// Action wrappers -- see that file's header comment for why.

import { db } from "@/lib/db";
import type { ProposalStatus } from "@/generated/prisma/enums";
import { createNewVersionFromLocked } from "@/lib/estimate-service";
import { UserError } from "@/lib/user-error";
import { proposalAuthority, type ProposalActor } from "@/lib/proposal-authority";
import { auditLineItemCategories } from "@/lib/category-audit";
import { changeOpportunityStage } from "@/lib/opportunity-service";
import { convertOpportunityToProject } from "@/lib/project-service";

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
//
// Once an estimate has ANY approved version, every later version must be
// approved by that same person -- a revision after changes isn't a fresh
// decision by whoever happens to be in the tool that day, it's the
// original approver re-confirming their own number. Enforced here, not
// just suggested in the UI: rejects outright rather than silently letting
// a different name get recorded. The very first approval on a brand-new
// estimate has no prior approver to match, so anyone authorized to work
// the estimate can make that first call.
export async function approveEstimateVersion(estimateVersionId: string, approvedById: string) {
  const version = await assertLocked(estimateVersionId);
  const priorApproval = await db.estimateVersion.findFirst({
    where: { estimateId: version.estimateId, isApproved: true, id: { not: estimateVersionId } },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true, approvedById: true, approvedBy: { select: { name: true } } },
  });
  if (priorApproval && priorApproval.approvedById !== approvedById) {
    throw new Error(
      `This estimate was previously approved by ${priorApproval.approvedBy?.name ?? "someone else"} ` +
        `(version ${priorApproval.versionNumber}) -- only they can approve a later version of it.`,
    );
  }
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
  const snapshot = {
    brandingConfig: template.brandingConfig ?? undefined,
    layoutConfig: template.layoutConfig ?? undefined,
  };

  // One unsent draft per version, refreshed rather than duplicated.
  //
  // This used to create a row every time it was called, so pressing
  // "Generate proposal" twice left two identical drafts with nothing to
  // say which one to send. A real estimate reached EIGHT, none of them
  // sent -- and with the proposal panel rendering each, the page became a
  // list of indistinguishable copies of the same document.
  //
  // The immutability rule this file already states is "immutable once
  // SENT", and that still holds below: a sent proposal is never touched,
  // and a re-send genuinely does make a new row. A draft nobody has sent
  // is just the current rendering of this version, and regenerating it is
  // what someone means when they press the button again -- usually after
  // changing the template.
  const existingDraft = await db.proposal.findFirst({
    where: { estimateVersionId, sentAt: null, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (existingDraft) {
    return db.proposal.update({
      where: { id: existingDraft.id },
      data: { templateId, templateConfigSnapshot: snapshot },
    });
  }

  return db.proposal.create({
    data: { estimateVersionId, templateId, templateConfigSnapshot: snapshot },
  });
}


// Immutable once sent (data-model-v0.md's Proposal versioning note) --
// re-sends create a new Proposal row via generateProposal above rather
// than mutating this one.
// `sentAt` is for recording a send that already happened outside ForgeOS
// -- a proposal emailed before this was being tracked. Without it, a
// system adopted mid-job can only ever say a thing was sent the day
// somebody got round to typing it in, which makes every "sent 14 days
// ago" reading wrong for exactly the deals that pre-date adoption.
export async function sendProposal(proposalId: string, sentAt?: Date) {
  // Goes through the lifecycle rather than writing sentAt directly, so
  // status and timestamp can never disagree and the send lands in the
  // history like every other transition. The gate itself lives in
  // recordProposalStatus -- see assertSendable.
  return recordProposalStatus(proposalId, "SENT", { at: sentAt });
}

// Everything that has to be true before a proposal reaches a client.
//
// This lives with the SENT transition rather than inside sendProposal
// because there are two doors to SENT: the send form on the proposal
// page, and "Mark sent to client" on the estimate's proposal panel. The
// category gate used to guard only the first one, which meant the button
// most people actually reach for could put a proposal in front of a
// client with line items in no category at all. A gate one of two doors
// enforces is not a gate.
//
// UserError throughout: every one of these is something the person can
// go and fix, and Next.js redacts anything else thrown out of a Server
// Action in production.
async function assertSendable(proposalId: string, when: Date | undefined) {
  const proposal = await db.proposal.findUniqueOrThrow({
    where: { id: proposalId },
    include: {
      estimateVersion: {
        include: { sections: { where: { optionId: null }, include: { lineItems: true } } },
      },
    },
  });
  if (proposal.sentAt) {
    throw new UserError(`This proposal was already sent at ${proposal.sentAt.toISOString()}.`);
  }

  // Hard gate, no override -- matches every other gate in this file.
  // Nothing with an unresolved category reaches a client: it either never
  // got categorized, or references a category that's since been renamed
  // (with no cascade -- shouldn't happen anymore, see
  // categories/actions.ts's updateCategory) or deleted out from under it.
  const categories = await db.category.findMany({ where: { deletedAt: null } });
  const audit = auditLineItemCategories(proposal.estimateVersion.sections, categories);
  if (!audit.isClean) {
    throw new UserError(
      `${audit.issues.length} line item(s) have an unresolved category ` +
        `(e.g. "${audit.issues[0].description.slice(0, 60)}") -- fix them on the estimate before sending.`,
    );
  }

  // A send in the future is a typo, and one before the version was even
  // locked could not have happened.
  if (when) {
    if (when.getTime() > Date.now()) throw new UserError("A proposal can't have been sent in the future.");
    if (proposal.estimateVersion.lockedAt && when < proposal.estimateVersion.lockedAt) {
      throw new UserError("That's before this version was locked, so it can't be when the proposal went out.");
    }
  }
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
  const proposal = await db.proposal.findUniqueOrThrow({
    where: { id: proposalId },
    include: { estimateVersion: { include: { estimate: { select: { opportunityId: true } } } } },
  });
  if (!proposal.sentAt) {
    throw new Error(`Proposal ${proposalId} must be sent before it can be marked signed.`);
  }
  if (proposal.signedAt) {
    throw new Error(`Proposal ${proposalId} was already signed at ${proposal.signedAt.toISOString()}.`);
  }
  // Status and signedAt together, then the attestation. Same reasoning as
  // sendProposal above: one path, so they cannot drift apart.
  await recordProposalStatus(proposalId, "SIGNED", {
    note: `Signed by ${signedByName.trim()}${signedByTitle?.trim() ? `, ${signedByTitle.trim()}` : ""}.`,
  });
  const signed = await db.proposal.update({
    where: { id: proposalId },
    data: {
      signedByName: signedByName.trim(),
      signedByTitle: signedByTitle?.trim() || null,
    },
  });

  // A signed proposal is the deal closing -- advance the opportunity to
  // WON (if it isn't already) and start production in the same gesture,
  // collapsing what used to be two disconnected manual steps (mark WON,
  // then separately click "Convert to Project") into the one moment that
  // actually represents the deal closing. Reuses changeOpportunityStage
  // (opportunity-service.ts) and convertOpportunityToProject
  // (project-service.ts) as-is rather than reimplementing the
  // stage/StageChangeEvent or Project-creation logic here -- the latter is
  // now idempotent specifically so it's safe to call from a second site
  // like this one without duplicating its own "already converted" guard.
  const opportunityId = proposal.estimateVersion.estimate.opportunityId;
  const opportunity = await db.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
  if (opportunity.stage !== "WON") {
    await changeOpportunityStage(opportunityId, "WON", "Auto-advanced: proposal signed");
  }
  await convertOpportunityToProject(opportunityId);

  return signed;
}

// --- lifecycle ---------------------------------------------------------
//
// sentAt/signedAt answer "when", and are still the source of truth for
// that. They cannot answer "where is this now": sent, reviewed and
// revisions-requested all look identical to them (sentAt set, signedAt
// null). ProposalStatus answers that, and every transition writes a
// ProposalEvent so a version history can say WHY the next version exists.
//
// The transitions a proposal may make. Deliberately a table rather than
// scattered ifs -- the same shape ARTWORK_TRANSITIONS uses for artwork
// orders, and for the same reason: the legal moves should be readable in
// one place.
export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  DRAFT: ["SENT"],
  // A client can sign straight off the sent copy without any review step
  // being recorded -- that is the happy path, not an anomaly.
  SENT: ["UNDER_REVIEW", "REVISIONS_REQUESTED", "SIGNED", "DECLINED"],
  UNDER_REVIEW: ["REVISIONS_REQUESTED", "SIGNED", "DECLINED"],
  // Revisions requested is not terminal: the revised proposal is a NEW
  // Proposal row (proposals are immutable once sent), so this one stays
  // where it is as the record of what the client actually received.
  REVISIONS_REQUESTED: ["SIGNED", "DECLINED"],
  SIGNED: [],
  DECLINED: [],
};

export function canTransitionProposal(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from]?.includes(to) ?? false;
}

// Records a transition and its reason. `note` is what the client actually
// said, and is required for a revision request -- "they want changes"
// with nothing else is the row someone returns to in three weeks and
// cannot act on.
export async function recordProposalStatus(
  proposalId: string,
  toStatus: ProposalStatus,
  opts: {
    note?: string | null;
    byUserId?: string | null;
    // Omitted for system-driven moves (sendProposal, signProposal), which
    // are already gated by their own rules and are not somebody deciding
    // where a client conversation stands.
    actor?: ProposalActor | null;
    managerConsulted?: boolean;
    // When this actually happened. Defaults to now; passed explicitly
    // when recording something that took place before ForgeOS was
    // tracking it, so the history reads as the truth rather than as the
    // day somebody typed it in.
    at?: Date;
  } = {},
) {
  const proposal = await db.proposal.findFirstOrThrow({
    where: { id: proposalId, deletedAt: null },
    select: { id: true, status: true, estimateVersionId: true },
  });
  if (!canTransitionProposal(proposal.status, toStatus)) {
    throw new UserError(
      `A proposal that is ${proposal.status.replaceAll("_", " ").toLowerCase()} can't move to ` +
        `${toStatus.replaceAll("_", " ").toLowerCase()}.`,
    );
  }
  const note = opts.note?.trim() || null;
  if (toStatus === "REVISIONS_REQUESTED" && !note) {
    throw new UserError("Say what the client asked to change -- that note is the reason the next version exists.");
  }

  // A manager moves a proposal on their own authority; anyone else has to
  // say they discussed it first, and that claim is recorded rather than
  // just checked -- see proposal-authority.ts.
  let managerConsulted = false;
  if (opts.actor) {
    const authority = proposalAuthority(opts.actor, opts.managerConsulted ?? false);
    if (!authority.allowed) throw new UserError(authority.reason ?? "You can't change this proposal's status.");
    managerConsulted = authority.requiresManagerConsultation;
  }

  // Applies to every status, not just SENT: a meeting held tomorrow has
  // not been held.
  if (opts.at && opts.at.getTime() > Date.now()) {
    throw new UserError("That date is in the future -- record what happened, not what's planned.");
  }

  const when = opts.at ?? new Date();
  if (toStatus === "SENT") await assertSendable(proposalId, opts.at);

  return db.$transaction(async (tx) => {
    const updated = await tx.proposal.update({
      where: { id: proposalId },
      // sentAt/signedAt are kept in step rather than superseded: plenty of
      // code still reads them, and they remain the honest answer to "when".
      data: {
        status: toStatus,
        ...(toStatus === "SENT" ? { sentAt: when } : {}),
        ...(toStatus === "SIGNED" ? { signedAt: when } : {}),
      },
    });
    await tx.proposalEvent.create({
      data: {
        proposalId,
        fromStatus: proposal.status,
        toStatus,
        note,
        byUserId: opts.byUserId ?? null,
        estimateVersionId: proposal.estimateVersionId,
        managerConsulted,
        createdAt: when,
      },
    });
    return updated;
  });
}

// "Updated costing requested." Records the request against the proposal
// the client is holding, then opens the next version for the estimator so
// the revised pricing has somewhere to land.
//
// What it deliberately does NOT do is touch the sent version. v1 stays
// locked, approved and sent -- it is the record of what the client
// actually received, and a revision request is not permission to rewrite
// history. The new version starts unlocked and unapproved, so it needs
// its own sign-off from the same approver before it can go out (see
// approveEstimateVersion's own rule).
export async function requestProposalRevisions(
  proposalId: string,
  note: string,
  byUserId: string | null,
  authority: { actor: ProposalActor; managerConsulted: boolean },
): Promise<{ newVersionId: string; versionNumber: number }> {
  const proposal = await db.proposal.findFirstOrThrow({
    where: { id: proposalId, deletedAt: null },
    select: { id: true, estimateVersionId: true, estimateVersion: { select: { isLocked: true, estimateId: true } } },
  });
  if (!proposal.estimateVersion.isLocked) {
    throw new UserError("This proposal's version isn't locked, so there's nothing to revise from.");
  }

  await recordProposalStatus(proposalId, "REVISIONS_REQUESTED", {
    note,
    byUserId,
    actor: authority.actor,
    managerConsulted: authority.managerConsulted,
  });
  // Reuses the same copy machinery "Create new version" and ChangeOrders
  // already use, rather than a third way of duplicating a version.
  const next = await createNewVersionFromLocked(proposal.estimateVersionId);
  return { newVersionId: next.id, versionNumber: next.versionNumber };
}
