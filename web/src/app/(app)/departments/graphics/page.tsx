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
import { DashboardActionModal } from "@/components/dashboard-action-modal";
import { BarBreakdown } from "@/components/bar-breakdown";
import {
  type DashTab,
  DashboardShell,
  DashCard,
  DashChip,
  DashEmpty,
  DashRow,
  DashRowAction,
  DashSection,
  DashStatStrip,
  type QuickAction,
} from "@/components/dashboard-shell";
import { getMyClientGraphicsSummary, getGraphicsOrders, getWeeklyDeliveredCounts, type GraphicsOrder } from "@/lib/artwork-hub";
import { getGraphicsBreakdowns, getAllClientsSummary } from "@/lib/graphics-breakdowns";
import { buildTodayBuckets } from "@/lib/graphics-today";
import { APPROVAL_LEAD_BUSINESS_DAYS } from "@/lib/graphics-sla";
import { AssignDesignerButton, IssueGoAheadButton, MarkSkidSentButton, SetHalfStatusButton } from "@/components/graphics-row-actions";
import { buildShopFloor } from "@/lib/graphics-shop-floor";
import { buildShipping } from "@/lib/graphics-shipping";
import { listDepartmentMembers, resolveDepartmentView } from "@/lib/department-viewing";
import { AssistantWidget } from "@/components/assistant-widget";
import { canUseAssistant, getDepartmentAssistant } from "@/lib/ai/assistant-registry";
import { listAssistantThreads } from "@/lib/assistant-service";

// Same "always fresh" reasoning as the Opportunities pipeline board and the
// generic Artwork review queue this page is a Graphics-specific front door
// for -- a live queue, not something that should freeze at build time.
export const dynamic = "force-dynamic";

// Show proximity is judged by the SOP's own 10-business-day approval lead
// (APPROVAL_LEAD_BUSINESS_DAYS), not by the arbitrary 14-day "starting
// soon" window this page used to invent for itself.
//
// A REJECTED order sitting this long without a client resubmission is
// worth calling out on its row -- shorter than this and it's just normal
// turnaround time, not something to flag.
const STALLED_REJECTION_DAYS = 3;
const THROUGHPUT_WEEKS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
// Each queue shows a handful and says how many more there are, rather than
// turning the landing page into a scroll. Same rule as the Sales dashboard.
const QUEUE_ROWS = 6;

type GraphicsTabKey = "today" | "shopfloor" | "shipping" | "production" | "department";

export default async function GraphicsHomePage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string; openAction?: string; tab?: string; as?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { opportunityId: selectedOpportunityId, tab: tabParam, as: asParam } = await searchParams;
  const isGrDept = canAccessArtworkOrdersViaDepartment(user);

  // Gates "Onboard a new client" and "Link a deal to a show" -- matches
  // onboardNewClientFromDashboardAction's own check exactly, so the form
  // never renders somewhere it would just throw on submit.
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  const canOnboardNewClient = isAdmin || isGrDept;
  // Whole-department oversight (the "Department" tab, its charts, the
  // all-clients table) is restricted to a designated head or an admin --
  // "the person or persons overseeing the department," not every member of
  // it. Everyday operational access (working any piece, the queues below)
  // stays department-wide for all GR staff, unchanged -- see
  // canViewDepartmentOversight's own comment.
  // Whose view of Graphics this is. An admin lands on the department head
  // rather than on themselves -- their own view of a shared board is just
  // their own name over everyone else's work. Read-only: `isSelf` gates
  // every row action below, so an admin can see what Gabriella sees and
  // cannot act in her name.
  const departmentMembers = await listDepartmentMembers("GR");
  const view = resolveDepartmentView(user, departmentMembers, asParam);
  // Oversight follows the VIEWED person, not the viewer -- that is what
  // makes "see what they see" mean anything. An admin viewing an ordinary
  // member loses the Department tab, exactly as that member does.
  const viewedIsHead = departmentMembers.find((m) => m.id === view.viewedId)?.isDepartmentHead ?? false;
  const canSeeOversight = view.isSelf ? canViewDepartmentOversight(user) : viewedIsHead;

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

  // "Link a deal to a show": every show in the system -- this isn't scoped
  // to opportunities the user can already see, since a show itself isn't
  // opportunity-scoped data -- paired with every not-yet-linked opportunity
  // the user has access to, same visibility rule as startableWhere above
  // (an opportunity gets shown here regardless of its own pipeline stage --
  // linking it to a show is what MAKES it eligible per
  // canStartArtworkOnboarding, not a result of already being eligible).
  const [shows, unassignedOpportunities, companies, designers, pastShowRows] = await Promise.all([
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
    // The designer pool the row-level "Assign" picker offers -- the same
    // Design-department query the artwork detail page's own picker uses, so
    // the two can't offer different people.
    db.user.findMany({
      where: { departmentCode: "DE", deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
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

  // The department's own assistant, if one is registered. Threads are
  // listed here rather than fetched by the widget so the page arrives
  // complete, same as /sales.
  // Same gate as /sales: a non-GR employee with no assigned clients falls
  // through this page's AE rollup and renders the full dashboard, so
  // "the page rendered" is not a permission check.
  const assistant = canUseAssistant(user, "GR") ? getDepartmentAssistant("GR") : null;
  const assistantThreads = assistant ? await listAssistantThreads(user.id, "GR") : [];

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
  // What actually has to happen today, per the Miami SOP -- see
  // graphics-today.ts. Every row lands in exactly one bucket, so nothing is
  // listed twice.
  const todayBuckets = buildTodayBuckets(
    orders,
    (o) => ({
      status: o.status,
      inHandDate: o.inHandDate,
      material: o.material,
      graphicCode: o.graphicCode,
      showStartDate: eventStartDateOf(o),
    }),
    now,
  );

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
  // A rejection the client has been sitting on for a while is worth saying
  // out loud on its row -- the piece is already in "waiting on a client",
  // this is how long it has been waiting.
  function rejectionAgeLabel(order: GraphicsOrder): string | null {
    if (order.status !== "REJECTED") return null;
    const rejectedAt = latestRejectedAt.get(order.id) ?? order.updatedAt;
    const days = Math.floor((now.getTime() - rejectedAt.getTime()) / DAY_MS);
    return days >= STALLED_REJECTION_DAYS ? `rejected ${days}d ago` : null;
  }

  // In-flight count for the Production tab -- everything not yet delivered
  // or cancelled.
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

  const tab: GraphicsTabKey =
    tabParam === "shopfloor"
      ? "shopfloor"
      : tabParam === "shipping"
        ? "shipping"
        : tabParam === "production"
        ? "production"
        : tabParam === "department" && canSeeOversight
          ? "department"
          : "today";

  // Department-tab-only data -- deliberately fetched/computed ONLY when the
  // user can see oversight AND is actually on that tab. Every tab is now a
  // separate server render (the nav is plain links, not a client Tabs
  // component holding both trees), so a non-head GR user's response can
  // never carry whole-department data it isn't showing. See
  // canViewDepartmentOversight's comment.
  const oversightData =
    canSeeOversight && tab === "department"
      ? {
          breakdowns: getGraphicsBreakdowns(orders),
          weeklyDelivered: await getWeeklyDeliveredCounts(user, THROUGHPUT_WEEKS),
          allClients: getAllClientsSummary(orders),
        }
      : null;

  // Only built for the tab that renders it -- the grouping walks every
  // piece's routings, which is wasted work on the other three.
  const shopFloor =
    tab === "shopfloor"
      ? buildShopFloor(
          orders,
          (o) => ({
            status: o.status,
            inHandDate: o.inHandDate,
            routings: o.routings.map((r) => ({
              id: r.id,
              kind: r.kind,
              productionStatus: r.productionStatus,
              vendor: r.vendor,
              office: r.office,
            })),
          }),
          now,
        )
      : null;

  // Only for the tab that renders it. Skids are show-scoped, so this asks
  // for every live show's crates at once -- the dashboard's whole point is
  // that you don't have to know which show a crate belongs to first.
  const shipping =
    tab === "shipping"
      ? buildShipping(
          orders,
          (o) => ({
            status: o.status,
            skidId: o.skidId,
            material: o.material,
            graphicCode: o.graphicCode,
            showStartDate: eventStartDateOf(o),
          }),
          (
            await db.skid.findMany({
              where: { deletedAt: null, show: { deletedAt: null } },
              orderBy: [{ sentAt: "desc" }, { code: "asc" }],
              select: {
                id: true,
                code: true,
                labelColor: true,
                sentAt: true,
                showId: true,
                show: { select: { name: true } },
              },
            })
          ).map((sk) => ({
            id: sk.id,
            code: sk.code,
            labelColor: sk.labelColor,
            sentAt: sk.sentAt,
            showId: sk.showId,
            showName: sk.show.name,
          })),
        )
      : null;

  const today = new Date();
  // Whose name sits in the hero. Viewing someone else names THEM, so it is
  // never ambiguous whose board is on screen -- "Gabriella's Graphics"
  // rather than a greeting addressed to the admin reading it.
  const firstName = view.isSelf
    ? (user.name.trim().split(/\s+/)[0] ?? user.name)
    : `${view.viewedName.trim().split(/\s+/)[0] ?? view.viewedName}'s`;
  // The one number the hero promises: every piece of work actually waiting
  // on this department right now. Counted by graphics-today, so it can't
  // drift from what the sections below actually list.
  const needsYou = todayBuckets.needsYou + needsPostShowReviewCount;

  // Carries the viewed person across tabs -- switching tabs should not
  // silently drop you back into your own view.
  const asQuery = view.isSelf ? "" : `&as=${encodeURIComponent(view.viewedId)}`;
  const tabHref = (key: GraphicsTabKey) => `/departments/graphics?tab=${key}${asQuery}`;
  const tabs: DashTab[] = [
    { key: "today", label: "Today", count: needsYou, href: tabHref("today"), active: tab === "today" },
    { key: "shopfloor", label: "Shop floor", href: tabHref("shopfloor"), active: tab === "shopfloor" },
    { key: "shipping", label: "Shipping", href: tabHref("shipping"), active: tab === "shipping" },
    {
      key: "production",
      label: "Production",
      count: inFlightLogCount,
      href: tabHref("production"),
      active: tab === "production",
    },
    ...(canSeeOversight
      ? [{ key: "department", label: "Department", href: tabHref("department"), active: tab === "department" } satisfies DashTab]
      : []),
  ];

  // Everything the kebab used to hide is a first-class action here. Opening
  // one is still a real navigation to ?openAction=... rather than client
  // state -- see DashboardActionModal's own reasoning.
  const quickActions: QuickAction[] = [
    { href: "/departments/graphics?openAction=order", label: "New artwork order", tone: "teal" },
    ...(canOnboardNewClient
      ? ([
          { href: "/departments/graphics?openAction=client", label: "New client", tone: "navy" },
          { href: "/departments/graphics?openAction=link", label: "Link a deal to a show", tone: "tangerine" },
        ] satisfies QuickAction[])
      : []),
    { href: "/artwork", label: "Artwork queue", tone: "gray" },
    { href: "/departments/graphics/log", label: "Production log", tone: "tan" },
    { href: "/departments/graphics/post-show", label: "Post-show", tone: "red" },
  ];

  const baseSubgreeting =
    needsYou === 0
      ? "Nothing is waiting on Graphics right now."
      : `${needsYou} thing${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} Graphics today.`;
  const subgreeting = view.isSelf
    ? baseSubgreeting
    : `${baseSubgreeting} You're reading ${view.viewedName}'s view — actions are off.`;

  // The dot marks a piece assigned to the person whose view this is (via
  // designerId) -- visible on every tab, so a producer scanning
  // department-wide urgent items can still spot their own at a glance. It
  // follows the VIEWED person, which is what makes an admin's "see what
  // Gabriella sees" show Gabriella's own pieces rather than the admin's.
  function orderTitle(order: GraphicsOrder) {
    const name = order.opportunity ? order.opportunity.company.name : "Show piece";
    return (
      <span className="flex items-center gap-2">
        {order.designerId === view.viewedId && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--dash-teal)]" title="Assigned to you" />
        )}
        {name}
      </span>
    );
  }
  // Always identifies the piece the same way -- which show, which job code
  // -- with anything bucket-specific appended by the caller as `note`.
  function orderSub(order: GraphicsOrder, note?: string | null) {
    const showName = order.opportunity ? order.opportunity.showName : order.show?.name;
    return [showName, order.jobCode, note].filter(Boolean).join(" · ");
  }
  interface QueueEntry {
    order: GraphicsOrder;
    right: React.ReactNode;
    note?: string | null;
  }
  function queueSection(
    title: string,
    rows: QueueEntry[],
    empty: string,
    link?: { href: string; label: string },
  ) {
    return (
      <DashSection title={`${title} (${rows.length})`} link={link}>
        {rows.length === 0 ? (
          <DashEmpty>{empty}</DashEmpty>
        ) : (
          <DashCard>
            {rows.slice(0, QUEUE_ROWS).map(({ order, right, note }) => (
              <DashRow
                key={order.id}
                href={`/artwork/${order.id}`}
                title={orderTitle(order)}
                sub={orderSub(order, note)}
                right={right}
                // Read-only while looking at someone else's view: an
                // admin can see what they see, not write in their name.
                actions={
                  view.isSelf ? (
                    <>
                      {order.status === "PROOF_APPROVED" && <IssueGoAheadButton artworkOrderId={order.id} />}
                      <AssignDesignerButton
                        artworkOrderId={order.id}
                        designers={designers}
                        currentDesignerId={order.designerId}
                      />
                    </>
                  ) : undefined
                }
              />
            ))}
            {rows.length > QUEUE_ROWS && (
              <DashRow title={`+ ${rows.length - QUEUE_ROWS} more`} href="/artwork" />
            )}
          </DashCard>
        )}
      </DashSection>
    );
  }

  // A turnaround inferred from a piece with no material on file is a
  // default, not a fact -- 282 imported Seatrade rows have none. The row
  // says so rather than presenting the guess as a deadline.
  const estimatedNote = (turnaroundIsKnown: boolean) => (turnaroundIsKnown ? null : "turnaround estimated");

  return (
    <DashboardShell
      id="forgeos-graphics"
      today={today}
      firstName={firstName}
      subgreeting={subgreeting}
      quickActions={quickActions}
      tabs={tabs}
    >
      {view.options.length > 0 && (
        <div className="dash-section">
          <div className="dash-section-head">
            <h2 className="dash-section-title">VIEWING</h2>
          </div>
          <DashCard>
            {/* A GET form, so the choice lands in the URL and the whole
                page re-renders from it -- same pattern as /sales' own rep
                switcher, and it means a viewed board can be linked to. */}
            <form action="/departments/graphics" className="flex flex-wrap items-center gap-2 px-5 py-3">
              <input type="hidden" name="tab" value={tab} />
              <select
                name="as"
                defaultValue={view.viewedId}
                className="rounded-md border border-[color:var(--dash-border)] bg-transparent px-3 py-1.5 text-sm"
              >
                {view.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.isDepartmentHead ? " — department head" : ""}
                  </option>
                ))}
              </select>
              <button type="submit" className="dash-qa dash-c-navy">
                <span className="dash-dot" />
                View
              </button>
              {!view.isSelf && (
                <span className="dash-row-sub">
                  Reading {view.viewedName}&apos;s view. Actions are disabled until you switch back to yourself.
                </span>
              )}
            </form>
          </DashCard>
        </div>
      )}

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
              <Button variant="secondary">Add client &amp; continue</Button>
            </div>
          </form>
        </DashboardActionModal>
      )}

      {canOnboardNewClient && (
        <DashboardActionModal title="Link a deal to a show" openParam="openAction" openValue="link" clearParams={["openAction"]}>
          {shows.length === 0 || unassignedOpportunities.length === 0 ? (
            <EmptyState
              message={
                shows.length === 0
                  ? "No shows exist yet to link a deal to."
                  : "Every deal you can see is already linked to a show."
              }
            />
          ) : (
            <>
              <p className="mb-4 text-sm text-neutral-500">
                Linking a deal to a show is what makes it eligible to start an artwork order, even before it&apos;s
                won.
              </p>
              <form action={linkOpportunityToShowFromDashboardAction} className="flex flex-col gap-4">
                <SelectField
                  label="Show"
                  name="showId"
                  defaultValue={defaultShowId}
                  options={shows.map((s) => ({ value: s.id, label: s.name }))}
                  required
                />
                <SelectField
                  label="Opportunity"
                  name="opportunityId"
                  defaultValue=""
                  options={[
                    { value: "", label: "Select an opportunity…" },
                    ...unassignedOpportunities.map((o) => ({ value: o.id, label: `${o.company.name} — ${o.showName}` })),
                  ]}
                  required
                />
                <div>
                  <Button variant="secondary">Link</Button>
                </div>
              </form>
            </>
          )}
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

      {tab === "today" && (
        <>
          <div className="dash-section">
            <DashStatStrip
              stats={[
                { value: String(todayBuckets.waitingOnUs.length), label: "Waiting on us", href: "/artwork" },
                { value: String(todayBuckets.overdue.length), label: "Past in-hand date", href: "/departments/graphics/log" },
                { value: String(todayBuckets.rushRisk.length), label: "Rush-fee risk", href: "/departments/graphics/log" },
                { value: String(inFlightOrders.length), label: "In flight", href: "/departments/graphics/log" },
                {
                  value: String(needsPostShowReviewCount),
                  label: "Post-show to review",
                  href: "/departments/graphics/post-show",
                },
              ]}
            />
          </div>

          {todayBuckets.escalated.length > 0 &&
            queueSection(
              "ESCALATED — NOTHING MOVES UNTIL THIS IS DECIDED",
              todayBuckets.escalated.map(({ order, sla }) => ({
                order,
                right: <DashChip tone="critical">Escalated</DashChip>,
                note: sla?.overdue ? `${Math.abs(sla.businessDaysRemaining)} business days past in-hand` : null,
              })),
              "",
            )}

          {todayBuckets.overdue.length > 0 &&
            queueSection(
              "PAST ITS IN-HAND DATE",
              todayBuckets.overdue.map(({ order, sla, turnaroundIsKnown }) => ({
                order,
                right: <DashChip tone="critical">{Math.abs(sla.businessDaysRemaining)}d over</DashChip>,
                note: estimatedNote(turnaroundIsKnown),
              })),
              "",
              { href: "/departments/graphics/log", label: "Production log" },
            )}

          {todayBuckets.rushRisk.length > 0 &&
            queueSection(
              "RUSH-FEE RISK",
              todayBuckets.rushRisk.map(({ order, sla, turnaroundIsKnown }) => ({
                order,
                right: (
                  <DashChip tone="critical">
                    {sla.businessDaysRemaining}d left, needs {sla.turnaroundDays}
                  </DashChip>
                ),
                note: estimatedNote(turnaroundIsKnown),
              })),
              "",
              { href: "/departments/graphics/log", label: "Production log" },
            )}

          {todayBuckets.approvalWindow.length > 0 &&
            queueSection(
              `NOT APPROVED, SHOW INSIDE ${APPROVAL_LEAD_BUSINESS_DAYS} BUSINESS DAYS`,
              todayBuckets.approvalWindow.map(({ order, businessDaysToShow }) => ({
                order,
                right: (
                  <DashChip tone={businessDaysToShow <= 0 ? "critical" : "info"}>
                    {businessDaysToShow <= 0 ? "show has started" : `${businessDaysToShow}d to setup`}
                  </DashChip>
                ),
              })),
              "",
              { href: "/shows", label: "All shows" },
            )}

          {queueSection(
            "WAITING ON US",
            todayBuckets.waitingOnUs.map(({ order, nextStep }) => {
              // The 24h proof-check timer is the one SLA the system has
              // always enforced -- it outranks the generic next-step label.
              const proofCheckLate = order.status === "EXPO_PROOF_CHECK" && order.slaDueAt != null && order.slaDueAt < now;
              return {
                order,
                right: proofCheckLate ? (
                  <DashChip tone="critical">
                    Proof check {Math.max(1, Math.floor((now.getTime() - order.slaDueAt!.getTime()) / DAY_MS))}d over
                  </DashChip>
                ) : (
                  <DashChip tone="info">{nextStep}</DashChip>
                ),
              };
            }),
            "Nothing is sitting with Graphics.",
            { href: "/artwork", label: "Artwork queue" },
          )}

          {queueSection(
            "WAITING ON A CLIENT OR VENDOR",
            todayBuckets.waitingOnOthers.map(({ order, nextStep }) => ({
              order,
              right: <DashChip tone="neutral">{nextStep}</DashChip>,
              note: rejectionAgeLabel(order),
            })),
            "Nothing is sitting with a client or a vendor.",
            { href: "/artwork", label: "Artwork queue" },
          )}
        </>
      )}

      {tab === "shopfloor" && shopFloor && (
        <>
          <div className="dash-section">
            <DashStatStrip
              stats={[
                { value: String(shopFloor.openHalfCount), label: "Open at a shop" },
                { value: String(shopFloor.lateHalfCount), label: "Past in-hand date" },
                { value: String(shopFloor.shops.length), label: "Shops with work" },
                { value: String(shopFloor.unrouted.length), label: "Not routed anywhere" },
              ]}
            />
          </div>

          {shopFloor.unrouted.length > 0 && (
            <DashSection title={`NOWHERE TO BE MADE (${shopFloor.unrouted.length})`}>
              <DashCard>
                {shopFloor.unrouted.slice(0, QUEUE_ROWS).map((order) => (
                  <DashRow
                    key={order.id}
                    href={`/artwork/${order.id}`}
                    title={orderTitle(order)}
                    sub={orderSub(order, "art accepted, no shop assigned")}
                    right={<DashChip tone="critical">Not routed</DashChip>}
                  />
                ))}
                {shopFloor.unrouted.length > QUEUE_ROWS && (
                  <DashRow title={`+ ${shopFloor.unrouted.length - QUEUE_ROWS} more`} href="/artwork" />
                )}
              </DashCard>
            </DashSection>
          )}

          {shopFloor.shops.length === 0 ? (
            <DashSection title="SHOPS">
              <DashEmpty>Nothing is out at a shop right now.</DashEmpty>
            </DashSection>
          ) : (
            shopFloor.shops.map((shop) => (
              <DashSection
                key={shop.key}
                title={`${shop.label.toUpperCase()} (${shop.open.length})`}
                link={
                  shop.kind === "VENDOR"
                    ? { href: "/catalog/vendors", label: "Vendors" }
                    : { href: "/departments/graphics/log", label: "Production log" }
                }
              >
                <DashCard>
                  {/* The shop's own summary line: where its open work
                      actually sits, and how much it has already finished --
                      context a list of six rows can't give on its own. */}
                  <DashRow
                    title={
                      <span className="flex flex-wrap items-center gap-1.5">
                        {shop.byStatus.map((s) => (
                          <DashChip key={s.status} tone="neutral">
                            {s.count} {s.label.toLowerCase()}
                          </DashChip>
                        ))}
                      </span>
                    }
                    sub={`${shop.settledCount} already settled${shop.lateCount > 0 ? ` · ${shop.lateCount} past its in-hand date` : ""}`}
                    right={shop.lateCount > 0 ? <DashChip tone="critical">{shop.lateCount} late</DashChip> : undefined}
                  />
                  {shop.open.slice(0, QUEUE_ROWS).map((half) => (
                    <DashRow
                      key={half.routingId}
                      href={`/artwork/${half.order.id}`}
                      title={orderTitle(half.order)}
                      sub={orderSub(
                        half.order,
                        half.inHandDate
                          ? `in hand ${half.inHandDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                          : "no in-hand date",
                      )}
                      right={half.late ? <DashChip tone="critical">Late</DashChip> : undefined}
                      actions={
                        view.isSelf ? (
                          <SetHalfStatusButton
                            routingId={half.routingId}
                            kind={half.kind}
                            current={half.productionStatus}
                          />
                        ) : undefined
                      }
                    />
                  ))}
                  {shop.open.length > QUEUE_ROWS && (
                    <DashRow
                      title={`+ ${shop.open.length - QUEUE_ROWS} more at this shop`}
                      href="/departments/graphics/log"
                    />
                  )}
                </DashCard>
              </DashSection>
            ))
          )}
        </>
      )}

      {tab === "shipping" && shipping && (
        <>
          <div className="dash-section">
            <DashStatStrip
              stats={[
                { value: String(shipping.readyToPackCount), label: "Ready to pack" },
                { value: String(shipping.onOpenSkidsCount), label: "Packed, not gone" },
                { value: String(shipping.openSkids.length), label: "Skids on the dock" },
                { value: String(shipping.sentSkids.length), label: "Skids sent" },
              ]}
            />
          </div>

          {shipping.shippedButNotMarked.length > 0 && (
            <DashSection title={`ON A SKID THAT HAS ALREADY GONE (${shipping.shippedButNotMarked.length})`}>
              <DashCard>
                {shipping.shippedButNotMarked.slice(0, QUEUE_ROWS).map((order) => (
                  <DashRow
                    key={order.id}
                    href={`/artwork/${order.id}`}
                    title={orderTitle(order)}
                    sub={orderSub(order, "its skid shipped, but the piece is still marked packaged")}
                    right={<DashChip tone="critical">Out of step</DashChip>}
                  />
                ))}
                {shipping.shippedButNotMarked.length > QUEUE_ROWS && (
                  <DashRow title={`+ ${shipping.shippedButNotMarked.length - QUEUE_ROWS} more`} href="/artwork" />
                )}
              </DashCard>
            </DashSection>
          )}

          <DashSection title={`READY TO PACK (${shipping.readyToPack.length})`} link={{ href: "/shows", label: "All shows" }}>
            {shipping.readyToPack.length === 0 ? (
              <DashEmpty>Nothing is finished and waiting for a crate.</DashEmpty>
            ) : (
              <DashCard>
                {shipping.readyToPack.slice(0, QUEUE_ROWS).map((order) => (
                  <DashRow
                    key={order.id}
                    href={`/artwork/${order.id}`}
                    title={orderTitle(order)}
                    sub={orderSub(order, order.material ?? "no material on file")}
                    right={<DashChip tone="info">Needs a skid</DashChip>}
                  />
                ))}
                {shipping.readyToPack.length > QUEUE_ROWS && (
                  <DashRow title={`+ ${shipping.readyToPack.length - QUEUE_ROWS} more`} href="/artwork" />
                )}
              </DashCard>
            )}
          </DashSection>

          {shipping.openSkids.length === 0 ? (
            <DashSection title="SKIDS ON THE DOCK">
              <DashEmpty>No skid is open. Start one from a show.</DashEmpty>
            </DashSection>
          ) : (
            shipping.openSkids.map(({ skid, contents }) => (
              <DashSection
                key={skid.id}
                title={`${skid.code.toUpperCase()} — ${skid.showName.toUpperCase()} (${contents.length})`}
                link={{ href: `/shows/${skid.showId}`, label: "Show" }}
              >
                <DashCard>
                  {/* Loaded heaviest first, per the SOP: PVC at the bottom,
                      fabric on top. This is the order to physically stack
                      it in, not a list sorted for reading. */}
                  <DashRow
                    title={
                      <span className="flex flex-wrap items-center gap-1.5">
                        {skid.labelColor && <DashChip tone="neutral">{skid.labelColor} label</DashChip>}
                        <span>Load in this order — heaviest first</span>
                      </span>
                    }
                    sub={contents.length === 0 ? "Nothing packed on it yet." : "PVC and acrylic at the bottom, fabric on top."}
                    actions={
                      view.isSelf ? (
                        <MarkSkidSentButton skidId={skid.id} code={skid.code} pieceCount={contents.length} />
                      ) : undefined
                    }
                  />
                  {contents.map((order, i) => (
                    <DashRow
                      key={order.id}
                      href={`/artwork/${order.id}`}
                      title={
                        <span className="flex items-center gap-2">
                          <span className="dash-row-sub tabular-nums">{i + 1}.</span>
                          {orderTitle(order)}
                        </span>
                      }
                      sub={orderSub(order, order.material ?? "no material on file")}
                      right={<DashChip tone="neutral">{order.qty > 1 ? `${order.qty} up` : "1 up"}</DashChip>}
                    />
                  ))}
                </DashCard>
              </DashSection>
            ))
          )}

          {shipping.sentSkids.length > 0 && (
            <DashSection title={`ALREADY SENT (${shipping.sentSkids.length})`}>
              <DashCard>
                {shipping.sentSkids.slice(0, QUEUE_ROWS).map(({ skid, contents }) => (
                  <DashRow
                    key={skid.id}
                    href={`/shows/${skid.showId}`}
                    title={`${skid.code} — ${skid.showName}`}
                    sub={`${contents.length} piece${contents.length === 1 ? "" : "s"} · left ${skid.sentAt?.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                    right={<DashChip tone="good">Gone</DashChip>}
                  />
                ))}
              </DashCard>
            </DashSection>
          )}
        </>
      )}

      {tab === "production" && (
        <>
          <DashSection title="PRODUCTION LOG" link={{ href: "/departments/graphics/log", label: "Open the full log" }}>
            <DashCard>
              <DashRow
                title={`${orders.length} piece${orders.length === 1 ? "" : "s"} tracked`}
                sub={`${inFlightLogCount} in flight · ${deliveredThisWeek.length} delivered in the last 7 days`}
                actions={<DashRowAction href="/departments/graphics/log/export">Export CSV</DashRowAction>}
              />
            </DashCard>
          </DashSection>

          <DashSection title="POST-SHOW" link={{ href: "/departments/graphics/post-show", label: "Open post-show" }}>
            <DashCard>
              <DashRow
                title={`${needsPostShowReviewCount} piece${needsPostShowReviewCount === 1 ? "" : "s"} need${needsPostShowReviewCount === 1 ? "s" : ""} review`}
                sub="Plus damaged and aging pieces awaiting client or sales follow-up."
              />
            </DashCard>
          </DashSection>

          <DashSection title={`PAST SHOWS (${pastShows.length})`} link={{ href: "/shows", label: "All shows" }}>
            {pastShows.length === 0 ? (
              <DashEmpty>No show has finished work archived against it yet.</DashEmpty>
            ) : (
              <DashCard>
                {pastShows.map((show) => (
                  <DashRow
                    key={show.id}
                    title={show.name}
                    sub={[
                      show.eventStartDate?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
                      `${show.pieces} piece${show.pieces === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    actions={
                      <>
                        <DashRowAction
                          href={`/departments/graphics/log?logShow=${encodeURIComponent(show.name)}&logArchived=1`}
                        >
                          Its pieces
                        </DashRowAction>
                        <DashRowAction href={`/shows/${show.id}`}>Open show</DashRowAction>
                      </>
                    }
                  />
                ))}
              </DashCard>
            )}
          </DashSection>

          <DashSection title="CATALOG">
            <DashCard>
              <DashRow title="Vendors" sub="Who produces what, and where" href="/catalog/vendors" />
              <DashRow title="Artwork size tiers" sub="The size bands pieces are priced and produced against" href="/catalog/artwork-size-tiers" />
            </DashCard>
          </DashSection>
        </>
      )}

      {tab === "department" && oversightData && (
        <>
          <DashSection title="BREAKDOWN">
            <DashCard>
              <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-3">
                <BarBreakdown title="By status" rows={oversightData.breakdowns.statusGroupRows} />
                <BarBreakdown title="By vendor" rows={oversightData.breakdowns.vendorRows} emptyMessage="No vendor assigned yet." />
                <BarBreakdown title="By client" rows={oversightData.breakdowns.clientRows} />
              </div>
            </DashCard>
          </DashSection>

          <DashSection
            title={`DELIVERED PER WEEK — LAST ${THROUGHPUT_WEEKS} WEEKS`}
            link={{ href: "/departments/graphics/analytics", label: "Analytics" }}
          >
            <DashCard>
              <div className="flex h-16 items-end gap-2 p-5">
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
                        className="w-full rounded-t bg-[color:var(--dash-teal)]"
                        style={{ height: `${Math.max((w.count / max) * CHART_HEIGHT_PX, w.count > 0 ? 6 : 2)}px` }}
                        title={`${w.count} delivered, week of ${w.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                      />
                    </div>
                  ));
                })()}
              </div>
            </DashCard>
          </DashSection>

          <DashSection title={`ALL CLIENTS (${oversightData.allClients.length})`}>
            {oversightData.allClients.length === 0 ? (
              <DashEmpty>No graphics tracked yet.</DashEmpty>
            ) : (
              <DashCard>
                {oversightData.allClients.map((row) => {
                  const pct = row.totalPieces === 0 ? 0 : Math.round((row.artReceivedCount / row.totalPieces) * 100);
                  return (
                    <DashRow
                      key={row.key}
                      href={row.href ?? undefined}
                      title={row.label}
                      sub={row.showLabel}
                      right={
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[color:var(--dash-border)]">
                            <span
                              className="block h-full rounded-full bg-[color:var(--dash-teal)]"
                              style={{ width: `${Math.max(pct, 4)}%` }}
                            />
                          </span>
                          <span className="dash-row-sub tabular-nums">
                            {row.artReceivedCount}/{row.totalPieces}
                          </span>
                        </span>
                      }
                    />
                  );
                })}
              </DashCard>
            )}
          </DashSection>
        </>
      )}
      {assistant && (
        <AssistantWidget
          departmentCode={assistant.departmentCode}
          label={assistant.label}
          description={assistant.description}
          suggestions={assistant.suggestions}
          initialThreads={assistantThreads.map((t) => ({
            id: t.id,
            title: t.title,
            lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
          }))}
        />
      )}
    </DashboardShell>
  );
}
