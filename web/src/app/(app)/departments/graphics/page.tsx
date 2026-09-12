import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { PageHeader, Card, Stat, StatusChip, EmptyState } from "@/components/ui";

// Same "always fresh" reasoning as the Opportunities pipeline board and the
// generic Artwork review queue this page is a Graphics-specific front door
// for -- a live queue, not something that should freeze at build time.
export const dynamic = "force-dynamic";

// A show starting this soon shows up in the "Shows in the next N days"
// section below -- a Graphics-relevant heads-up window, not a hard
// business rule (no SLA is tied to it).
const UPCOMING_SHOW_WINDOW_DAYS = 14;
// A REJECTED order sitting this long without a client resubmission is
// worth a nudge -- shorter than this and it's just normal turnaround time,
// not something to flag.
const STALLED_REJECTION_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export default async function GraphicsHomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Same query artwork/page.tsx uses, including the department-wide
  // widening (a Graphics user sees every ArtworkOrder, not just ones on
  // opportunities they own/collaborate on) -- reused rather than
  // reinvented since this page is a Graphics-specific front door onto the
  // exact same queue, not a different data set.
  const orders = await db.artworkOrder.findMany({
    where: {
      deletedAt: null,
      ...(canAccessArtworkOrdersViaDepartment(user) ? {} : { opportunity: opportunityAccessWhere(user) }),
    },
    orderBy: { updatedAt: "desc" },
    include: {
      opportunity: { include: { company: true, show: { select: { id: true, name: true } } } },
      vendor: { select: { name: true } },
    },
  });

  const now = new Date();

  // ESCALATED gets its own callout below rather than folding into this
  // count -- it needs a manual resolution step, not just a look.
  const reviewOrders = orders.filter((o) => o.status === "UNDER_ART_REVIEW" || o.status === "EXPO_PROOF_CHECK");
  const escalatedOrders = orders.filter((o) => o.status === "ESCALATED");
  // Same SLA rule artwork/page.tsx already uses (EXPO_PROOF_CHECK only) --
  // not a new/wider definition of "overdue."
  const slaOverdueOrders = orders.filter(
    (o) => o.status === "EXPO_PROOF_CHECK" && o.slaDueAt != null && o.slaDueAt < now,
  );
  const inFlightOrders = orders.filter((o) => o.status !== "DELIVERED_AT_SHOW");
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const deliveredThisWeek = orders.filter((o) => o.status === "DELIVERED_AT_SHOW" && o.updatedAt >= sevenDaysAgo);

  // opportunity.eventStartDate comes through for free on the query above --
  // Prisma's `include` returns every scalar field of the related record,
  // only nested relations need their own explicit selection.
  const upcomingWindowEnd = new Date(now.getTime() + UPCOMING_SHOW_WINDOW_DAYS * DAY_MS);
  const upcomingShowOrders = orders
    .filter((o) => o.status !== "DELIVERED_AT_SHOW")
    .filter((o) => {
      const eventStartDate = o.opportunity.eventStartDate;
      return eventStartDate != null && eventStartDate >= now && eventStartDate <= upcomingWindowEnd;
    })
    .sort((a, b) => a.opportunity.eventStartDate!.getTime() - b.opportunity.eventStartDate!.getTime());

  const rejectedOrders = orders.filter((o) => o.status === "REJECTED");
  const rejectedEvents = rejectedOrders.length
    ? await db.artworkOrderEvent.findMany({
        where: { artworkOrderId: { in: rejectedOrders.map((o) => o.id) }, toStatus: "REJECTED" },
        orderBy: { createdAt: "desc" },
        select: { artworkOrderId: true, createdAt: true },
      })
    : [];
  // Latest REJECTED-transition event per order -- an order can be rejected,
  // resubmitted, and rejected again, so this is "when did it MOST
  // RECENTLY become rejected," not the first time ever. Falls back to
  // updatedAt in the (shouldn't-happen) case no matching event exists.
  const latestRejectedAt = new Map<string, Date>();
  for (const e of rejectedEvents) {
    if (!latestRejectedAt.has(e.artworkOrderId)) latestRejectedAt.set(e.artworkOrderId, e.createdAt);
  }
  const stalledRejections = rejectedOrders
    .map((order) => ({ order, rejectedAt: latestRejectedAt.get(order.id) ?? order.updatedAt }))
    .filter(({ rejectedAt }) => now.getTime() - rejectedAt.getTime() >= STALLED_REJECTION_DAYS * DAY_MS)
    .sort((a, b) => a.rejectedAt.getTime() - b.rejectedAt.getTime());

  return (
    <>
      {/* noBack: this page functions as this user's actual home ("/"
          redirects here), so a "back to Dashboard" crumb would just send
          them right back to this same page. */}
      <PageHeader title="Graphics" noBack />
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Link href="/artwork">
            <Stat value={String(reviewOrders.length)} label="Awaiting review" />
          </Link>
          <Link href="/artwork">
            <Stat
              value={String(slaOverdueOrders.length)}
              label="SLA overdue"
              className={slaOverdueOrders.length > 0 ? "border-red-300" : ""}
            />
          </Link>
          <Link href="/artwork">
            <Stat value={String(inFlightOrders.length)} label="In flight" />
          </Link>
          <Link href="/artwork">
            <Stat value={String(deliveredThisWeek.length)} label="Delivered this week" />
          </Link>
        </div>

        {escalatedOrders.length > 0 && (
          <Card className="border-red-300 bg-red-50 p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-red-700">
              Escalated — needs manual resolution ({escalatedOrders.length})
            </h2>
            <ul className="flex flex-col gap-2">
              {escalatedOrders.map((order) => (
                <li key={order.id}>
                  <Link
                    href={`/artwork/${order.id}`}
                    className="flex items-center justify-between rounded-md border border-red-200 bg-white px-4 py-3 text-sm hover:border-red-400"
                  >
                    <span className="flex items-center gap-3">
                      <span className="font-medium">{order.opportunity.company.name}</span>
                      <span className="text-neutral-500">{order.opportunity.showName}</span>
                      <span className="font-mono text-xs text-neutral-400">{order.jobCode}</span>
                    </span>
                    <StatusChip tone="critical">Escalated</StatusChip>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Shows in the next {UPCOMING_SHOW_WINDOW_DAYS} days ({upcomingShowOrders.length})
          </h2>
          {upcomingShowOrders.length === 0 ? (
            <EmptyState message="Nothing with an artwork order in flight is starting soon." />
          ) : (
            <ul className="flex flex-col gap-2">
              {upcomingShowOrders.map((order) => {
                const daysUntil = Math.ceil(
                  (order.opportunity.eventStartDate!.getTime() - now.getTime()) / DAY_MS,
                );
                return (
                  <li key={order.id}>
                    <Link
                      href={`/artwork/${order.id}`}
                      className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-4 py-3 text-sm hover:border-neutral-400"
                    >
                      <span className="flex items-center gap-3">
                        <span className="font-medium">{order.opportunity.company.name}</span>
                        <span className="text-neutral-500">{order.opportunity.showName}</span>
                        <span className="font-mono text-xs text-neutral-400">{order.jobCode}</span>
                      </span>
                      <StatusChip tone={daysUntil <= 3 ? "critical" : "warning"}>
                        {daysUntil === 0 ? "Today" : `${daysUntil}d`}
                      </StatusChip>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Awaiting client resubmission ({stalledRejections.length})
          </h2>
          {stalledRejections.length === 0 ? (
            <EmptyState message="No rejected submissions have been sitting for a while." />
          ) : (
            <ul className="flex flex-col gap-2">
              {stalledRejections.map(({ order, rejectedAt }) => {
                const daysStalled = Math.floor((now.getTime() - rejectedAt.getTime()) / DAY_MS);
                return (
                  <li key={order.id}>
                    <Link
                      href={`/artwork/${order.id}`}
                      className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-4 py-3 text-sm hover:border-neutral-400"
                    >
                      <span className="flex items-center gap-3">
                        <span className="font-medium">{order.opportunity.company.name}</span>
                        <span className="text-neutral-500">{order.opportunity.showName}</span>
                        <span className="font-mono text-xs text-neutral-400">{order.jobCode}</span>
                      </span>
                      <StatusChip tone="warning">{daysStalled}d since rejected</StatusChip>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="flex flex-wrap gap-4 text-sm">
          <Link href="/artwork" className="text-neutral-600 hover:underline">
            Full artwork queue →
          </Link>
          <Link href="/catalog/artwork-size-tiers" className="text-neutral-600 hover:underline">
            Size-tier catalog →
          </Link>
          <Link href="/catalog/vendors" className="text-neutral-600 hover:underline">
            Vendors →
          </Link>
        </div>
      </div>
    </>
  );
}
