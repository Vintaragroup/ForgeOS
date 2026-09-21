// Graphics Production Hub reads that don't belong in artwork-order-service.ts
// (the state machine) or opportunity-access.ts (the shared access-control
// axis) -- the Account Executive summary below is deliberately its own,
// separate scoping rule, not a widening of either.

import { db } from "@/lib/db";
import { ACTIVE_ARTWORK_ORDER } from "@/lib/artwork-scope";
import type { ArtworkOrderStatus, SystemRole } from "@/generated/prisma/enums";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { rolloverArtworkOrder, type ArtworkActor } from "@/lib/artwork-order-service";

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

// "My clients" for an Account Executive OR a PM/deal owner -- filters on
// Opportunity.salesRepId === user.id OR ownerId === user.id, completely
// independent of opportunityAccessWhere (see this file's own header
// comment and ArtworkOrder.designerId's schema-adjacent discussion:
// salesRepId is deliberately never used for the owner/collaborator access
// axis, only for commission math and now this summary). Widened to also
// match ownerId (the Graphics Dashboard v2 plan's own "PM" role) rather
// than building a second, separate rollup -- same restriction either way:
// only opportunities THIS user is personally assigned to, never
// department-wide. Mirrors getTasksForUser's own `mineOnly` pattern
// (src/lib/tasks.ts) -- either role sees their assigned clients' graphics
// even on an opportunity they don't otherwise own/collaborate on via that
// separate axis. Read-only: no drill-in to the restricted /artwork/[id]
// page, same as the source spreadsheet's own "Account Executive Dashboard"
// tab, which is itself just a rollup with no per-piece links either.
export async function getMyClientGraphicsSummary(user: { id: string }): Promise<ClientGraphicsSummary[]> {
  const opportunities = await db.opportunity.findMany({
    where: {
      deletedAt: null,
      OR: [{ salesRepId: user.id }, { ownerId: user.id }],
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

// Every non-deleted ArtworkOrder this user can see -- department-wide for a
// GR user (or admin, via opportunityAccessWhere's own isAdmin bypass),
// otherwise scoped to opportunities they own/collaborate on. Shared by the
// Graphics landing dashboard (departments/graphics/page.tsx, for its
// triage sections) and the Production Log page
// (departments/graphics/log/page.tsx, for the full filterable table +
// chart breakdowns) -- one query definition so the two pages' data can't
// silently drift apart.
export async function getGraphicsOrders(user: { id: string; systemRole: SystemRole; departmentCode: string | null }) {
  return db.artworkOrder.findMany({
    where: {
      ...ACTIVE_ARTWORK_ORDER,
      ...(canAccessArtworkOrdersViaDepartment(user) ? {} : { opportunity: opportunityAccessWhere(user) }),
    },
    orderBy: { updatedAt: "desc" },
    include: {
      opportunity: { include: { company: true, show: { select: { id: true, name: true } } } },
      // Only set for a Hub/hanging-sign piece with no opportunity -- see
      // ArtworkOrder.showId's schema comment.
      show: { select: { id: true, name: true, eventStartDate: true } },
      vendor: { select: { name: true } },
      designer: { select: { name: true } },
    },
  });
}

export type GraphicsOrder = Awaited<ReturnType<typeof getGraphicsOrders>>[number];

export interface WeeklyDeliveredCount {
  weekStart: Date;
  count: number;
}

// Throughput trend for the Department-mode dashboard's sparkline and the
// Analytics view's fuller chart -- "pieces actually delivered per week,"
// not a point-in-time snapshot like the status/vendor/client breakdowns
// above. Reads ArtworkOrderEvent (the audit trail), not
// ArtworkOrder.updatedAt, since updatedAt can move for reasons unrelated to
// delivery (a later field edit) -- the event's own createdAt is the actual
// moment the order transitioned to DELIVERED_AT_SHOW, matching how
// artwork-hub's own rejectedEvents logic (departments/graphics/page.tsx)
// already prefers the event trail over updatedAt for the same reason.
// weeks buckets are Sunday-start, oldest first, always `weeks` entries long
// even if some weeks had zero deliveries (a real gap in the trend, not a
// missing data point).
export async function getWeeklyDeliveredCounts(
  user: { id: string; systemRole: SystemRole; departmentCode: string | null },
  weeks: number,
): Promise<WeeklyDeliveredCount[]> {
  const now = new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const rangeStart = new Date(now.getTime() - weeks * 7 * DAY_MS);

  const events = await db.artworkOrderEvent.findMany({
    where: {
      toStatus: "DELIVERED_AT_SHOW",
      createdAt: { gte: rangeStart },
      artworkOrder: {
        ...ACTIVE_ARTWORK_ORDER,
        ...(canAccessArtworkOrdersViaDepartment(user) ? {} : { opportunity: opportunityAccessWhere(user) }),
      },
    },
    select: { createdAt: true },
  });

  // Sunday of the current week, at local midnight -- the anchor every
  // bucket's own start is computed backward from, so "this week" is always
  // the last bucket regardless of what day `now` falls on.
  const currentWeekStart = new Date(now);
  currentWeekStart.setHours(0, 0, 0, 0);
  currentWeekStart.setDate(currentWeekStart.getDate() - currentWeekStart.getDay());

  const buckets: WeeklyDeliveredCount[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setDate(weekStart.getDate() - i * 7);
    buckets.push({ weekStart, count: 0 });
  }

  // Direct range membership per event, not an arithmetic offset -- the
  // offset version got this wrong for the in-progress current week (a
  // createdAt after currentWeekStart makes that subtraction negative,
  // which floors toward -Infinity and lands one bucket past the end of the
  // array, silently dropping every delivery from the current week).
  for (const event of events) {
    const bucket = buckets.find(
      (b) => event.createdAt >= b.weekStart && event.createdAt.getTime() < b.weekStart.getTime() + 7 * DAY_MS,
    );
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

export interface RolloverShowResult {
  opportunitiesCreated: number;
  piecesCreated: number;
}

// Bulk-creates a fresh Opportunity + ArtworkOrder set under `targetShowId`
// for every returning client on `sourceShowId` -- the actual business logic
// behind the Show detail page's "Roll over clients" action
// (shows/actions.ts's rolloverShowAction). Pulled out into this plain,
// explicit-actor function -- rather than left inlined in the Server Action
// -- for the same reason every function in artwork-order-service.ts already
// takes an explicit actor: this codebase has no getCurrentUser() mocking
// precedent anywhere in its test suite, so auth-dependent Server Actions
// stay thin wrappers and the real logic lives here where it can be unit
// tested directly.
//
// Idempotent -- safe to call twice. A returning client already rolled into
// the target show (matched by companyId) is skipped, and within that
// opportunity each piece is deduped by graphicCode, so a partial prior run
// (or someone already having drafted artwork orders on the target
// opportunity by hand) doesn't get duplicated.
export async function rolloverShow(
  { sourceShowId, targetShowId }: { sourceShowId: string; targetShowId: string },
  actor: ArtworkActor,
): Promise<RolloverShowResult> {
  const sourceOpportunities = await db.opportunity.findMany({
    where: { deletedAt: null, showId: sourceShowId },
    include: { artworkOrders: { where: { deletedAt: null } } },
  });

  let opportunitiesCreated = 0;
  let piecesCreated = 0;

  for (const source of sourceOpportunities) {
    const alreadyRolled = await db.opportunity.findFirst({
      where: { deletedAt: null, showId: targetShowId, companyId: source.companyId },
    });
    let targetOpportunityId = alreadyRolled?.id;
    if (!targetOpportunityId) {
      const created = await db.opportunity.create({
        data: {
          companyId: source.companyId,
          showId: targetShowId,
          showName: source.showName,
          salesRepId: source.salesRepId,
          ownerId: source.ownerId,
        },
      });
      targetOpportunityId = created.id;
      opportunitiesCreated++;
    }

    for (const piece of source.artworkOrders) {
      const alreadyRolledPiece = await db.artworkOrder.findFirst({
        where: { deletedAt: null, opportunityId: targetOpportunityId, graphicCode: piece.graphicCode },
      });
      if (alreadyRolledPiece) continue;
      await rolloverArtworkOrder(piece, { opportunityId: targetOpportunityId }, actor);
      piecesCreated++;
    }
  }

  // Hub/hanging-sign pieces -- no opportunity, tied directly to the show
  // itself (see ArtworkOrder.showId's own schema comment).
  const sourceHubPieces = await db.artworkOrder.findMany({
    where: { deletedAt: null, showId: sourceShowId, opportunityId: null },
  });
  for (const piece of sourceHubPieces) {
    const alreadyRolledPiece = await db.artworkOrder.findFirst({
      where: { deletedAt: null, showId: targetShowId, opportunityId: null, graphicCode: piece.graphicCode },
    });
    if (alreadyRolledPiece) continue;
    await rolloverArtworkOrder(piece, { showId: targetShowId }, actor);
    piecesCreated++;
  }

  return { opportunitiesCreated, piecesCreated };
}
