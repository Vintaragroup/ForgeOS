import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { PageHeader, Card, StatusChip, EmptyState } from "@/components/ui";
import { OrderIdentity } from "@/components/artwork-order-identity";

// Same "always fresh" reasoning as the rest of the Graphics dashboard's own
// pages -- a live operational queue, not something that should freeze at
// build time.
export const dynamic = "force-dynamic";

const DAMAGE_NOTIFIED_ACTION = "NOTIFIED_CLIENT_OF_DAMAGE";
const AGING_DECIDED_ACTIONS = ["AGING_KEPT_IN_CIRCULATION", "AGING_MARKED_FOR_REPLACEMENT"];

export default async function GraphicsPostShowPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  const isGrDept = canAccessArtworkOrdersViaDepartment(user);
  // Same gate as the Production Log -- operational work for Graphics
  // staff/admins, not an oversight-only surface (unlike Analytics/
  // Department mode, this isn't aggregate department-wide data, it's a
  // queue of individual pieces someone needs to actually go act on).
  if (!isGrDept && !isAdmin) redirect("/departments/graphics");

  // Deliberately not scoped to status === DELIVERED_AT_SHOW alone -- a lot
  // of real historical data (bulk-imported from a past show) already has
  // postShowStatus recorded even though its own ArtworkOrder.status never
  // walked through the live ship/deliver transitions. Both a piece that's
  // NEWLY eligible to record a disposition and a piece that already HAS
  // one belong on this page.
  const orders = await db.artworkOrder.findMany({
    where: {
      deletedAt: null,
      ...(isGrDept ? {} : { opportunity: opportunityAccessWhere(user) }),
      OR: [{ status: "DELIVERED_AT_SHOW" }, { postShowStatus: { not: null } }],
    },
    include: {
      opportunity: { include: { company: true, show: { select: { id: true, name: true } } } },
      show: { select: { id: true, name: true } },
    },
    orderBy: { postShowRecordedAt: "desc" },
  });

  // Archived pieces are excluded from "needs review" but kept everywhere
  // else on this page. A disposition is a decision about a piece someone
  // still has in hand; once a show is archived nobody is going to walk its
  // graphics. Importing Seatrade put 197 finished pieces from a show that
  // ran in April into this queue, which is work that will never be done
  // and hides work that might.
  //
  // Deliberately only the queue: the damaged/aging/discarded lists below
  // are history, and history is the reason this page reads archived rows
  // in the first place.
  const needsReview = orders.filter(
    (o) => o.status === "DELIVERED_AT_SHOW" && o.postShowStatus === null && o.archivedAt === null,
  );
  const archivedWithoutDisposition = orders.filter(
    (o) => o.status === "DELIVERED_AT_SHOW" && o.postShowStatus === null && o.archivedAt !== null,
  ).length;
  const damaged = orders.filter((o) => o.postShowCondition === "DAMAGED");
  const aging = orders.filter((o) => o.postShowCondition === "AGING");
  const discarded = orders.filter((o) => o.postShowStatus === "DISCARDED").slice(0, 25);

  const [notifiedEvents, agingDecidedEvents] = await Promise.all([
    damaged.length
      ? db.artworkOrderEvent.findMany({
          where: { artworkOrderId: { in: damaged.map((o) => o.id) }, action: DAMAGE_NOTIFIED_ACTION },
          select: { artworkOrderId: true },
        })
      : Promise.resolve([]),
    aging.length
      ? db.artworkOrderEvent.findMany({
          where: { artworkOrderId: { in: aging.map((o) => o.id) }, action: { in: AGING_DECIDED_ACTIONS } },
          select: { artworkOrderId: true },
        })
      : Promise.resolve([]),
  ]);
  const notifiedSet = new Set(notifiedEvents.map((e) => e.artworkOrderId));
  const agingDecidedSet = new Set(agingDecidedEvents.map((e) => e.artworkOrderId));

  // Both of these are ACTION queues, not history, so archived pieces come
  // out of them for the same reason they come out of needsReview above.
  // Getting this wrong the first time left a red "Damaged -- awaiting
  // client notice (50)" card on the page in which all 50 were archived
  // PGA pieces: nobody is chasing a client about a graphic from a show
  // that closed in January.
  //
  // The damaged/aging/discarded lists further down keep everything,
  // archived included -- those really are history.
  const damagedAwaitingNotice = damaged.filter((o) => !notifiedSet.has(o.id) && o.archivedAt === null);
  const agingAwaitingFollowup = aging.filter((o) => !agingDecidedSet.has(o.id) && o.archivedAt === null);

  function Row({ order, chip }: { order: (typeof orders)[number]; chip: React.ReactNode }) {
    return (
      <li>
        <Link
          href={`/artwork/${order.id}`}
          className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-4 py-3 text-sm hover:border-neutral-400"
        >
          <span className="flex items-center gap-3">
            <OrderIdentity order={order} />
            <span className="font-mono text-xs text-neutral-400">{order.jobCode}</span>
          </span>
          {chip}
        </Link>
      </li>
    );
  }

  return (
    <>
      <PageHeader title="Post-show" backHref="/departments/graphics" backLabel="Graphics" />
      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Needs review ({needsReview.length})
          </h2>
          <p className="mb-3 text-xs text-neutral-500">
            Delivered at the show, no post-show disposition recorded yet.
            {archivedWithoutDisposition > 0 &&
              ` ${archivedWithoutDisposition} more sit on shows that are already closed — those are history, not a queue.`}
          </p>
          {needsReview.length === 0 ? (
            <EmptyState message="Nothing new is waiting on a post-show review." />
          ) : (
            <ul className="flex flex-col gap-2">
              {needsReview.map((o) => (
                <Row key={o.id} order={o} chip={<StatusChip tone="warning">Needs review</StatusChip>} />
              ))}
            </ul>
          )}
        </Card>

        {damagedAwaitingNotice.length > 0 && (
          <Card className="border-red-300 bg-red-50 p-5">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-red-700">
              Damaged — awaiting client notice ({damagedAwaitingNotice.length})
            </h2>
            <p className="mb-3 text-xs text-red-700/80">
              Graphics has been notified for each of these. Open a piece to review the reference photos and decide
              whether/how to loop the client in.
            </p>
            <ul className="flex flex-col gap-2">
              {damagedAwaitingNotice.map((o) => (
                <Row key={o.id} order={o} chip={<StatusChip tone="critical">Damaged</StatusChip>} />
              ))}
            </ul>
          </Card>
        )}

        {agingAwaitingFollowup.length > 0 && (
          <Card className="p-5">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Aging — awaiting sales follow-up ({agingAwaitingFollowup.length})
            </h2>
            <p className="mb-3 text-xs text-neutral-500">
              Sales has been notified for each of these. Waiting on a keep-in-circulation or replace decision.
            </p>
            <ul className="flex flex-col gap-2">
              {agingAwaitingFollowup.map((o) => (
                <Row key={o.id} order={o} chip={<StatusChip tone="warning">Aging</StatusChip>} />
              ))}
            </ul>
          </Card>
        )}

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Recently discarded ({discarded.length}
            {orders.filter((o) => o.postShowStatus === "DISCARDED").length > discarded.length ? "+" : ""})
          </h2>
          {discarded.length === 0 ? (
            <EmptyState message="Nothing recorded as discarded yet." />
          ) : (
            <ul className="flex flex-col gap-2">
              {discarded.map((o) => (
                <Row
                  key={o.id}
                  order={o}
                  chip={
                    <StatusChip tone="neutral">
                      {o.postShowDiscardReason === "CLIENT_APPROVED_DISPOSAL"
                        ? "Client approved"
                        : o.postShowDiscardReason === "AGED_OUT"
                          ? "Aged out"
                          : "Damaged beyond repair"}
                    </StatusChip>
                  }
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
