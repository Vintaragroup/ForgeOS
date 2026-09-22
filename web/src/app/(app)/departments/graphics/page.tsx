import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment, canViewDepartmentOversight } from "@/lib/department-access";
import {
  startArtworkOrderFromDashboardAction,
  linkOpportunityToShowFromDashboardAction,
  onboardNewClientFromDashboardAction,
} from "./actions";
import { PageHeader, Card, Stat, StatusChip, EmptyState, SelectField, Field, Button } from "@/components/ui";
import { CompanyFieldWithCreate } from "@/components/company-field-with-create";
import { OrderIdentity } from "@/components/artwork-order-identity";
import { DashboardActionModal } from "@/components/dashboard-action-modal";
import { GraphicsQuickActionsMenu } from "@/components/graphics-quick-actions-menu";
import { BarBreakdown } from "@/components/bar-breakdown";
import { Tabs } from "@/components/tabs";
import { getMyClientGraphicsSummary, getGraphicsOrders, getWeeklyDeliveredCounts, type GraphicsOrder } from "@/lib/artwork-hub";
import { getGraphicsBreakdowns, getAllClientsSummary } from "@/lib/graphics-breakdowns";

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
const THROUGHPUT_WEEKS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

// Big, tappable action -- the dashboard's "act, don't hunt" front door
// (+ Client, + Create Order). A plain Link styled to match, not the
// Button component (which only renders a <button>, no href) -- opening
// stays a real navigation to ?openAction=..., not client state, per
// DashboardActionModal's own reasoning.
function ActionButton({ href, variant, children }: { href: string; variant: "primary" | "secondary"; children: React.ReactNode }) {
  const styles =
    variant === "primary"
      ? "bg-brand-black text-white hover:bg-brand-navy"
      : "bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50";
  return (
    <Link href={href} className={`flex h-11 items-center gap-2 rounded-lg px-5 text-sm font-semibold ${styles}`}>
      {children}
    </Link>
  );
}

export default async function GraphicsHomePage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string; openAction?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // TS doesn't retain the null-narrowing above across the nested QueueRow
  // function declared further down -- a separately bound const does.
  const currentUserId = user.id;

  const { opportunityId: selectedOpportunityId } = await searchParams;
  const isGrDept = canAccessArtworkOrdersViaDepartment(user);

  // Gates "Onboard a new client" and the kebab below -- matches
  // onboardNewClientFromDashboardAction's own check exactly, so the form
  // never renders somewhere it would just throw on submit.
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  const canOnboardNewClient = isAdmin || isGrDept;
  // Whole-department oversight (the "Department" tab, its charts, the
  // all-clients table) is restricted to a designated head or an admin --
  // "the person or persons overseeing the department," not every member of
  // it. Everyday operational access (working any piece, the queue below)
  // stays department-wide for all GR staff, unchanged -- see
  // canViewDepartmentOversight's own comment.
  const canSeeOversight = canViewDepartmentOversight(user);

  // A non-Graphics-department, non-admin user with assigned clients gets a
  // dedicated, read-only rollup instead of this whole page -- mirrors the
  // source spreadsheet's own "Account Executive Dashboard" tab, which is
  // itself just this same rollup with no other content on it. Checked (and
  // returned) before any of the GR-only queries below run, since none of
  // them apply to this user anyway (opportunityAccessWhere already scopes
  // them down to next-to-nothing for a pure AE/PM with no ownership/
  // collaborator access).
  if (!isGrDept && !isAdmin) {
    const myClients = await getMyClientGraphicsSummary(user);
    if (myClients.length > 0) {
      const clientsWithArtIn = myClients.filter((c) => c.artReceivedCount === c.totalPieces).length;
      return (
        <>
          <PageHeader title="Your clients' graphics" noBack />
          <div className="mb-6 grid grid-cols-2 gap-4">
            <Stat value={`${clientsWithArtIn}/${myClients.length}`} label="Clients with art in" />
            <Stat value={String(myClients.length)} label="Total clients tracked" />
          </div>
          <Card className="p-5">
            <ul className="flex flex-col gap-2">
              {myClients.map((c) => {
                const pct = c.totalPieces === 0 ? 0 : Math.round((c.artReceivedCount / c.totalPieces) * 100);
                return (
                  <li key={c.opportunityId}>
                    <Link
                      href={`/opportunities/${c.opportunityId}`}
                      className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-4 py-3 text-sm hover:border-neutral-400"
                    >
                      <span className="flex items-center gap-3">
                        <span className="font-medium">{c.companyName}</span>
                        <span className="text-neutral-500">{c.showName}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-neutral-100">
                          <span
                            className="block h-full rounded-full bg-brand-teal"
                            style={{ width: `${Math.max(pct, 4)}%` }}
                          />
                        </span>
                        <StatusChip tone={c.artReceivedCount === c.totalPieces ? "good" : "warning"}>
                          {c.artReceivedCount}/{c.totalPieces}
                        </StatusChip>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      );
    }
  }

  // Same visibility rule as the orders query below: department-wide for a
  // GR member (or an admin, via opportunityAccessWhere's own isAdmin
  // bypass), otherwise scoped to opportunities this specific user owns or
  // collaborates on -- so this picker never offers to start an order on an
  // opportunity the user couldn't otherwise see.
  const startableWhere = canAccessArtworkOrdersViaDepartment(user) ? {} : opportunityAccessWhere(user);
  // Only opportunities eligible per canStartArtworkOnboarding (Won, or
  // linked to a show -- see that function's own comment) with no artwork
  // order yet -- mirrors the opportunity page's own Artwork section, which
  // likewise only shows the invite form while artworkOrders.length === 0 (a
  // repeat order for the same opportunity is still possible, just not from
  // this quick-start picker -- use the opportunity's own page for that).
  // Combined via AND rather than spreading startableWhere's own OR
  // alongside a second OR here -- two sibling `OR` keys on one Prisma
  // where-object would silently collide (the second overwrites the first),
  // which would wrongly drop the ownership scoping for a non-department
  // employee.
  const startableOpportunities = await db.opportunity.findMany({
    where: {
      AND: [
        startableWhere,
        { deletedAt: null },
        { artworkOrders: { none: { deletedAt: null } } },
        { OR: [{ stage: "WON" }, { showId: { not: null } }] },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, companyId: true, showName: true, primaryContactId: true, company: { select: { name: true } } },
  });

  // Fewer clicks for the common case: with exactly one eligible opportunity,
  // there's nothing a "Continue" click could actually disambiguate -- treat
  // it as selected on page load rather than making the user pick the only
  // option and click through to see it.
  const selectedOpportunity = selectedOpportunityId
    ? startableOpportunities.find((o) => o.id === selectedOpportunityId)
    : startableOpportunities.length === 1
      ? startableOpportunities[0]
      : undefined;
  const selectedOpportunityContacts = selectedOpportunity
    ? await db.contact.findMany({
        where: { deletedAt: null, companyId: selectedOpportunity.companyId },
        orderBy: { name: "asc" },
      })
    : [];

  // "Link an opportunity to a show" (kebab): every show in the system --
  // this isn't scoped to opportunities the user can already see, since a
  // show itself isn't opportunity-scoped data -- paired with every
  // not-yet-linked opportunity the user has access to, same visibility rule
  // as startableWhere above (an opportunity gets shown here regardless of
  // its own pipeline stage -- linking it to a show is what MAKES it
  // eligible per canStartArtworkOnboarding, not a result of already being
  // eligible).
  const [shows, unassignedOpportunities, companies, pastShowRows] = await Promise.all([
    // Soonest-first -- the show someone's actually about to work is the one
    // that matters most in a picker, not alphabetical order. A show with no
    // event date set yet (nulls) sorts last, after every dated show.
    db.show.findMany({
      where: { deletedAt: null },
      orderBy: { eventStartDate: { sort: "asc", nulls: "last" } },
      select: { id: true, name: true, eventStartDate: true },
    }),
    db.opportunity.findMany({
      where: { ...startableWhere, deletedAt: null, showId: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, showName: true, company: { select: { name: true } } },
    }),
    // "Onboard a new client" below -- every company, not scoped to
    // opportunity access, since picking an existing company here is just
    // naming it, the same as CompanyFieldWithCreate's other caller
    // (opportunities/new) already does with no such scoping either.
    canOnboardNewClient
      ? db.company.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } })
      : Promise.resolve([]),
    // Shows that still have archived pieces on them. Archiving keeps
    // finished work out of the queues, which is right -- but with no way
    // to reach it, a department whose history had just been archived saw
    // a dashboard of zeros and nothing else. This is that history's front
    // door.
    db.artworkOrder.groupBy({
      by: ["showId"],
      where: { deletedAt: null, archivedAt: { not: null }, showId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // Shared with the Production Log page (departments/graphics/log/page.tsx)
  // -- same department-wide widening for a GR user, one query definition
  // so the two pages' data can't silently drift apart.
  const orders = await getGraphicsOrders(user);

  // Both Show pickers below default to it when there's exactly one show in
  // the system -- nothing to disambiguate yet, so don't make every single
  // onboarding/link ask which show, when there's only ever one right answer
  // (still overridable the moment a second show exists).
  const defaultShowId = shows.length === 1 ? shows[0].id : "";

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
  // only nested relations need their own explicit selection. A Hub/
  // hanging-sign order (opportunity null) falls back to its own Show's
  // eventStartDate instead -- see ArtworkOrder.showId's schema comment.
  function eventStartDateOf(order: GraphicsOrder): Date | null {
    return order.opportunity?.eventStartDate ?? order.show?.eventStartDate ?? null;
  }
  const upcomingWindowEnd = new Date(now.getTime() + UPCOMING_SHOW_WINDOW_DAYS * DAY_MS);
  const upcomingShowOrders = orders
    .filter((o) => o.status !== "DELIVERED_AT_SHOW")
    .filter((o) => {
      const eventStartDate = eventStartDateOf(o);
      return eventStartDate != null && eventStartDate >= now && eventStartDate <= upcomingWindowEnd;
    })
    .sort((a, b) => eventStartDateOf(a)!.getTime() - eventStartDateOf(b)!.getTime());

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

  // In-flight count for the Production Log teaser card below -- everything
  // not yet delivered or cancelled.
  const inFlightLogCount = orders.filter((o) => o.status !== "DELIVERED_AT_SHOW" && o.status !== "CANCELLED").length;
  // Newest first: last year's occurrence is the one someone rolls forward.
  const showById = new Map(shows.map((sh) => [sh.id, sh]));
  const pastShows: { id: string; name: string; eventStartDate: Date | null; pieces: number }[] = [];
  for (const row of pastShowRows) {
    const show = row.showId ? showById.get(row.showId) : undefined;
    if (show) pastShows.push({ ...show, pieces: row._count._all });
  }
  pastShows.sort((a, b) => (b.eventStartDate?.getTime() ?? 0) - (a.eventStartDate?.getTime() ?? 0));

  const needsPostShowReviewCount = orders.filter((o) => o.status === "DELIVERED_AT_SHOW" && o.postShowStatus === null).length;

  // Department-mode-only data -- deliberately fetched/computed ONLY when
  // canSeeOversight is true, not fetched-but-hidden. A Tabs child's
  // content prop is a Server Component tree that's already been rendered
  // into the RSC payload by the time Tabs (a Client Component) decides
  // whether to display it -- fetching this unconditionally would leak
  // whole-department data into a non-head GR user's network response even
  // while the UI never shows it. See canViewDepartmentOversight's comment.
  const oversightData = canSeeOversight
    ? {
        breakdowns: getGraphicsBreakdowns(orders),
        weeklyDelivered: await getWeeklyDeliveredCounts(user, THROUGHPUT_WEEKS),
        allClients: getAllClientsSummary(orders),
      }
    : null;

  const linkOpportunityWithShow = linkOpportunityToShowFromDashboardAction;

  function QueueRow({ order, chip }: { order: GraphicsOrder; chip: React.ReactNode }) {
    // The dot marks a piece assigned to THIS user specifically (via
    // designerId) -- visible in both modes, so a producer scanning
    // department-wide urgent items can still spot their own at a glance.
    const isMine = order.designerId === currentUserId;
    return (
      <li>
        <Link
          href={`/artwork/${order.id}`}
          className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-4 py-3 text-sm hover:border-neutral-400"
        >
          <span className="flex items-center gap-3">
            {isMine && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-teal" title="Assigned to you" />}
            <OrderIdentity order={order} />
            <span className="font-mono text-xs text-neutral-400">{order.jobCode}</span>
          </span>
          {chip}
        </Link>
      </li>
    );
  }

  const focusContent = (
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
              <QueueRow key={order.id} order={order} chip={<StatusChip tone="critical">Escalated</StatusChip>} />
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
              const daysUntil = Math.ceil((eventStartDateOf(order)!.getTime() - now.getTime()) / DAY_MS);
              return (
                <QueueRow
                  key={order.id}
                  order={order}
                  chip={
                    <StatusChip tone={daysUntil <= 3 ? "critical" : "warning"}>
                      {daysUntil === 0 ? "Today" : `${daysUntil}d`}
                    </StatusChip>
                  }
                />
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
                <QueueRow
                  key={order.id}
                  order={order}
                  chip={<StatusChip tone="warning">{daysStalled}d since rejected</StatusChip>}
                />
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Production log</h2>
            <p className="mt-1 text-sm text-neutral-600">
              <span className="font-medium text-neutral-900">{orders.length}</span> pieces tracked,{" "}
              <span className="font-medium text-neutral-900">{inFlightLogCount}</span> in flight.
            </p>
          </div>
          <Link
            href="/departments/graphics/log"
            className="rounded-md bg-brand-black px-4 py-2 text-sm font-medium text-white hover:bg-brand-navy"
          >
            View full production log →
          </Link>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Post-show</h2>
            <p className="mt-1 text-sm text-neutral-600">
              <span className="font-medium text-neutral-900">{needsPostShowReviewCount}</span> need
              {needsPostShowReviewCount === 1 ? "s" : ""} review — plus damaged/aging pieces awaiting client or sales
              follow-up.
            </p>
          </div>
          <Link
            href="/departments/graphics/post-show"
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            View post-show →
          </Link>
        </div>
      </Card>

      {pastShows.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Past shows</h2>
          <p className="mb-3 text-xs text-neutral-500">
            Finished work, kept out of the queues above. Open one to see what was produced, or roll it into next
            year&apos;s occurrence.
          </p>
          <ul className="flex flex-col gap-2">
            {pastShows.map((show) => (
              <li key={show.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2">
                <span className="text-sm">
                  <Link href={`/shows/${show.id}`} className="font-medium hover:underline">
                    {show.name}
                  </Link>
                  {show.eventStartDate && (
                    <span className="text-neutral-500">
                      {" "}
                      · {show.eventStartDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                  )}
                  <span className="text-neutral-500"> · {show.pieces} piece{show.pieces === 1 ? "" : "s"}</span>
                </span>
                <Link
                  href={`/departments/graphics/log?logShow=${encodeURIComponent(show.name)}&logArchived=1`}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                >
                  See its pieces →
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
  );

  const departmentContent = oversightData && (
    <div className="flex flex-col gap-6">
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <BarBreakdown title="By status" rows={oversightData.breakdowns.statusGroupRows} />
          <BarBreakdown title="By vendor" rows={oversightData.breakdowns.vendorRows} emptyMessage="No vendor assigned yet." />
          <BarBreakdown title="By client" rows={oversightData.breakdowns.clientRows} />
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Delivered per week, last {THROUGHPUT_WEEKS} weeks
        </h2>
        <div className="flex h-16 items-end gap-2">
          {(() => {
            const CHART_HEIGHT_PX = 64;
            const max = Math.max(1, ...oversightData.weeklyDelivered.map((w) => w.count));
            return oversightData.weeklyDelivered.map((w) => (
              <div key={w.weekStart.toISOString()} className="flex flex-1 flex-col items-center justify-end gap-1">
                {/* Pixel height, not a percentage -- a percentage height
                    on a flex item under items-end resolves against
                    max-content (the item isn't stretched to the row's
                    own height), which collapses every bar to 0 regardless
                    of count. This div's own parent has a real h-16 (64px)
                    to compute against instead. */}
                <div
                  className="w-full rounded-t bg-brand-teal"
                  style={{ height: `${Math.max((w.count / max) * CHART_HEIGHT_PX, w.count > 0 ? 6 : 2)}px` }}
                  title={`${w.count} delivered, week of ${w.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                />
              </div>
            ));
          })()}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          All clients ({oversightData.allClients.length})
        </h2>
        {oversightData.allClients.length === 0 ? (
          <EmptyState message="No graphics tracked yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-3">Client</th>
                  <th className="py-2 pr-3">Show</th>
                  <th className="py-2 pr-3">Pieces</th>
                  <th className="py-2 pr-3">Art received</th>
                </tr>
              </thead>
              <tbody>
                {oversightData.allClients.map((row) => {
                  const pct = row.totalPieces === 0 ? 0 : Math.round((row.artReceivedCount / row.totalPieces) * 100);
                  return (
                    <tr key={row.key} className="border-b border-neutral-100">
                      <td className="py-2 pr-3 font-medium text-neutral-800">
                        {row.href ? (
                          <Link href={row.href} className="hover:underline">
                            {row.label}
                          </Link>
                        ) : (
                          row.label
                        )}
                      </td>
                      <td className="py-2 pr-3 text-neutral-500">{row.showLabel}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.totalPieces}</td>
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100">
                            <span className="block h-full rounded-full bg-brand-teal" style={{ width: `${Math.max(pct, 4)}%` }} />
                          </span>
                          <span className="tabular-nums text-neutral-500">
                            {row.artReceivedCount}/{row.totalPieces}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm text-neutral-600">📊 Turnaround, SLA trend, and show comparisons</span>
          <Link
            href="/departments/graphics/analytics"
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            View analytics →
          </Link>
        </div>
      </Card>
    </div>
  );

  return (
    <>
      {/* noBack: this page functions as this user's actual home ("/"
          redirects here), so a "back to Dashboard" crumb would just send
          them right back to this same page. */}
      <PageHeader
        title="Graphics"
        noBack
        action={
          <div className="flex items-center gap-2">
            {canOnboardNewClient && (
              <ActionButton href="?openAction=client" variant="primary">
                + Client
              </ActionButton>
            )}
            <ActionButton href="?openAction=order" variant="secondary">
              + Create Order
            </ActionButton>
            {canOnboardNewClient && (
              <GraphicsQuickActionsMenu
                linkOpportunityAction={linkOpportunityWithShow}
                showOptions={[{ value: "", label: "Select a show…" }, ...shows.map((s) => ({ value: s.id, label: s.name }))]}
                opportunityOptions={[
                  { value: "", label: "Select an opportunity…" },
                  ...unassignedOpportunities.map((o) => ({ value: o.id, label: `${o.company.name} — ${o.showName}` })),
                ]}
                defaultShowId={defaultShowId}
                exportHref="/departments/graphics/log/export"
              />
            )}
          </div>
        }
      />

      {canOnboardNewClient && (
        <DashboardActionModal title="Onboard a new client" openParam="openAction" openValue="client" clearParams={["openAction"]}>
          <p className="mb-4 text-sm text-neutral-500">
            For an exhibitor that isn&apos;t in the system yet -- creates their company (or picks an existing
            one), a contact, and a deal in one step, then goes straight to inviting them.
          </p>
          <form action={onboardNewClientFromDashboardAction} className="flex flex-col gap-4">
            <CompanyFieldWithCreate companies={companies} />
            <div className="flex flex-wrap gap-3">
              <div className="min-w-56 flex-1">
                <Field label="Contact name" name="contactName" required />
              </div>
              <div className="min-w-56 flex-1">
                <Field label="Contact email" name="contactEmail" type="email" required />
              </div>
            </div>
            <div className="min-w-56">
              <SelectField
                label="Show"
                name="showId"
                defaultValue={defaultShowId}
                options={[
                  { value: "", label: "— none (standalone deal) —" },
                  ...shows.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </div>
            <div>
              <Button variant="secondary">Add client & continue</Button>
            </div>
          </form>
        </DashboardActionModal>
      )}

      <DashboardActionModal title="Start an artwork order" openParam="openAction" openValue="order" clearParams={["openAction", "opportunityId"]}>
        {startableOpportunities.length === 0 ? (
          <EmptyState message="No opportunity is ready to start an artwork order right now -- won a deal, or linked one to a show, to see it here." />
        ) : (
          <>
            <form method="GET" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="openAction" value="order" />
              <div className="min-w-72">
                <SelectField
                  label="Opportunity"
                  name="opportunityId"
                  defaultValue={selectedOpportunity?.id ?? selectedOpportunityId ?? ""}
                  options={[
                    { value: "", label: "Select an opportunity…" },
                    ...startableOpportunities.map((o) => ({
                      value: o.id,
                      label: `${o.company.name} — ${o.showName}`,
                    })),
                  ]}
                  required
                />
              </div>
              <Button variant="secondary">Continue</Button>
            </form>

            {selectedOpportunity && (
              <form action={startArtworkOrderFromDashboardAction} className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="opportunityId" value={selectedOpportunity.id} />
                <div className="min-w-64">
                  <SelectField
                    label="Client contact"
                    name="contactId"
                    defaultValue={selectedOpportunity.primaryContactId ?? ""}
                    options={[
                      { value: "", label: "Select a contact…" },
                      ...selectedOpportunityContacts.map((c) => ({
                        value: c.id,
                        label: c.email ? `${c.name} (${c.email})` : c.name,
                      })),
                    ]}
                    required
                  />
                </div>
                <Button variant="secondary">Invite to Artwork Portal</Button>
              </form>
            )}
          </>
        )}
      </DashboardActionModal>

      {canSeeOversight ? (
        <Tabs
          paramName="mode"
          tabs={[
            { id: "focus", label: "My focus" },
            { id: "department", label: "Department" },
          ]}
          content={{ focus: focusContent, department: departmentContent }}
        />
      ) : (
        focusContent
      )}
    </>
  );
}
