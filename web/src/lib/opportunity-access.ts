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
