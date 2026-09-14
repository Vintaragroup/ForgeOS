// Graphics Production Hub reads that don't belong in artwork-order-service.ts
// (the state machine) or opportunity-access.ts (the shared access-control
// axis) -- the Account Executive summary below is deliberately its own,
// separate scoping rule, not a widening of either.

import { db } from "@/lib/db";
import type { ArtworkOrderStatus } from "@/generated/prisma/enums";

// A piece hasn't had its artwork received yet while it's still sitting in
// the client's own hands -- INVITED (not even started) or ORDER_DRAFTED/
// REJECTED (drafting or fixing a rejection, pre-submission). Every other
// status implies the client has at least submitted something, even if
// Expo later asks for a revision. Kept as its own named set rather than an
// inline check so the judgment call is visible in one place.
const ART_NOT_YET_RECEIVED_STATUSES: ReadonlySet<ArtworkOrderStatus> = new Set(["INVITED", "ORDER_DRAFTED", "REJECTED"]);

export interface ClientGraphicsSummary {
  opportunityId: string;
  companyName: string;
  showName: string;
  totalPieces: number;
  artReceivedCount: number;
}

// "My clients" for an Account Executive -- filters directly on
// Opportunity.salesRepId === user.id, completely independent of
// opportunityAccessWhere (see this file's own header comment and
// ArtworkOrder.designerId's schema-adjacent discussion: salesRepId is
// deliberately never used for the owner/collaborator access axis, only
// for commission math and now this summary). Mirrors getTasksForUser's
// own `mineOnly` pattern (src/lib/tasks.ts) -- an AE sees their assigned
// clients' graphics even on an opportunity they don't own or collaborate
// on. Read-only: no drill-in to the restricted /artwork/[id] page, same
// as the source spreadsheet's own "Account Executive Dashboard" tab,
// which is itself just a rollup with no per-piece links either.
export async function getMyClientGraphicsSummary(user: { id: string }): Promise<ClientGraphicsSummary[]> {
  const opportunities = await db.opportunity.findMany({
    where: {
      deletedAt: null,
      salesRepId: user.id,
      artworkOrders: { some: { deletedAt: null } },
    },
    select: {
      id: true,
      showName: true,
      company: { select: { name: true } },
      artworkOrders: { where: { deletedAt: null }, select: { status: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return opportunities.map((o) => ({
    opportunityId: o.id,
    companyName: o.company.name,
    showName: o.showName,
    totalPieces: o.artworkOrders.length,
    artReceivedCount: o.artworkOrders.filter((a) => !ART_NOT_YET_RECEIVED_STATUSES.has(a.status)).length,
  }));
}
