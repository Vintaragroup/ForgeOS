// Per-Opportunity access control -- a second, orthogonal authorization
// axis alongside SystemRole (src/lib/auth.ts). SystemRole answers "can
// this user manage the /admin area"; this answers "can this user see
// THIS specific Opportunity and everything under it." ADMIN/SUPER_ADMIN
// bypass this axis entirely, same as they already bypass every other
// per-resource concern in this app -- only EMPLOYEE is ever scoped.
//
// A user can access an Opportunity if they're an admin, OR they own it
// (Opportunity.ownerId), OR they're an explicit OpportunityCollaborator.
// Owner is not also inserted as a collaborator row -- it's a separate,
// simpler check, so ownership transfer (changing ownerId) can't
// accidentally strand the old owner with lingering access via a stale
// collaborator row nobody remembered to clean up.

import type { Prisma, SystemRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

type AccessUser = { id: string; systemRole: SystemRole };

function isAdmin(user: AccessUser): boolean {
  return user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
}

export async function canAccessOpportunity(user: AccessUser, opportunityId: string): Promise<boolean> {
  if (isAdmin(user)) return true;

  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      ownerId: true,
      collaborators: { where: { userId: user.id }, select: { id: true } },
    },
  });
  if (!opportunity) return false;

  return opportunity.ownerId === user.id || opportunity.collaborators.length > 0;
}

// For Server Actions -- same shape as auth.ts's requireAdmin()/
// requireSuperAdmin(): no params beyond what's being checked, calls
// getCurrentUser() itself, throws on failure, returns the user on
// success so callers can reuse requester.id without a second lookup.
// Server Actions self-check rather than trust a page's own gate, for
// the same reason /admin actions do (see auth.ts's comment on
// requireAdmin) -- a Server Action is independently reachable.
export async function requireOpportunityAccess(opportunityId: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  if (!(await canAccessOpportunity(user, opportunityId))) {
    throw new Error("You don't have access to this opportunity");
  }
  return user;
}

// Convenience wrapper for Server Actions that receive an estimateId
// rather than an opportunityId directly (most of estimates/actions.ts and
// estimates/[id]/import-actions.ts) -- one extra query to resolve the
// owning opportunity, then the same check as requireOpportunityAccess.
export async function requireEstimateAccess(estimateId: string) {
  const estimate = await db.estimate.findUniqueOrThrow({
    where: { id: estimateId },
    select: { opportunityId: true },
  });
  return requireOpportunityAccess(estimate.opportunityId);
}

// Verifies versionId actually belongs to estimateId -- requireEstimateAccess
// only checks the CALLER can access estimateId; without this, an action
// that also takes a versionId (nearly every action in estimates/actions.ts,
// cut-list/actions.ts, import-actions.ts) could be pointed at a DIFFERENT
// estimate's version just by supplying its ID, bypassing the access check
// entirely even though requireEstimateAccess itself never failed. The same
// cross-resource gap document-service.ts's functions were fixed for, one
// level up the ownership chain -- call this immediately after
// requireEstimateAccess in any action that also receives a versionId.
export async function assertVersionBelongsToEstimate(estimateId: string, versionId: string): Promise<void> {
  const version = await db.estimateVersion.findFirst({ where: { id: versionId, estimateId }, select: { id: true } });
  if (!version) throw new Error("This estimate version doesn't belong to the given estimate.");
}

// Same cross-resource gap as assertVersionBelongsToEstimate above, one
// level further down the chain -- a bid-package-actions.ts action that
// takes a bidPackageId could otherwise be pointed at a DIFFERENT
// estimate's package just by supplying its ID.
export async function assertBidPackageBelongsToEstimate(estimateId: string, bidPackageId: string): Promise<void> {
  const bidPackage = await db.bidPackage.findFirst({
    where: { id: bidPackageId, estimateVersion: { estimateId } },
    select: { id: true },
  });
  if (!bidPackage) throw new Error("This bid package doesn't belong to the given estimate.");
}

// Resolves an estimateId to its owning opportunityId -- for a caller that
// already called requireEstimateAccess and now needs the opportunityId
// itself to scope a nested-ID ownership check (see estimate-service.ts's
// deleteLineItem/updateLineItem/moveSectionOrder/etc., cost-actual-
// service.ts's recordCostActual): a lineItemId or sectionId taken from a
// form alone doesn't prove it belongs to the estimate the caller was
// actually authorized for, the same cross-resource ID gap document-
// service.ts's deleteDocument/updateDocumentType/assignDocumentEstimate
// were fixed for.
export async function estimateOpportunityId(estimateId: string): Promise<string> {
  const estimate = await db.estimate.findUniqueOrThrow({ where: { id: estimateId }, select: { opportunityId: true } });
  return estimate.opportunityId;
}

// Same idea as requireEstimateAccess, for actions taking a projectId.
export async function requireProjectAccess(projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { opportunityId: true },
  });
  return requireOpportunityAccess(project.opportunityId);
}

// Same idea, for actions taking only a proposalId -- Proposal has no
// opportunityId of its own (3 hops: proposal -> estimateVersion ->
// estimate -> opportunityId).
export async function requireProposalAccess(proposalId: string) {
  const proposal = await db.proposal.findUniqueOrThrow({
    where: { id: proposalId },
    select: { estimateVersion: { select: { estimate: { select: { opportunityId: true } } } } },
  });
  return requireOpportunityAccess(proposal.estimateVersion.estimate.opportunityId);
}

// For findMany list queries -- {} (no restriction) for admins, else an
// OR over ownership/collaboration. Spread into a where-clause directly
// for models with a direct opportunityId (Opportunity itself), or
// nested under an `opportunity:` relation key for models one or more
// hops away (e.g. `{ opportunity: opportunityAccessWhere(user) }`).
export function opportunityAccessWhere(user: AccessUser): Prisma.OpportunityWhereInput {
  if (isAdmin(user)) return {};
  return {
    OR: [{ ownerId: user.id }, { collaborators: { some: { userId: user.id } } }],
  };
}
