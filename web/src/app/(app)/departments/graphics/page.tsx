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

// Same "always fresh" reasoning as the Opportunities pipeline board and the
// generic Artwork review queue this page is a Graphics-specific front door
// for -- a live queue, not something that should freeze at build time.
export const dynamic = "force-dynamic";

// A show starting this soon shows up in the "Starting soon" section below --
// a Graphics-relevant heads-up window, not a hard business rule (no SLA is
// tied to it).
const UPCOMING_SHOW_WINDOW_DAYS = 14;
// A REJECTED order sitting this long without a client resubmission is
// worth a nudge -- shorter than this and it's just normal turnaround time,
// not something to flag.
const STALLED_REJECTION_DAYS = 3;
const THROUGHPUT_WEEKS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
// Each queue shows a handful and says how many more there are, rather than
// turning the landing page into a scroll. Same rule as the Sales dashboard.
const QUEUE_ROWS = 6;

type GraphicsTabKey = "today" | "production" | "department";

export default async function GraphicsHomePage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string; openAction?: string; tab?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // TS doesn't retain the null-narrowing above across the row helpers
  // declared further down -- a separately bound const does.
  const currentUserId = user.id;

  const { opportunityId: selectedOpportunityId, tab: tabParam } = await searchParams;
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

  // "Link a deal to a show": every show in the system -- this isn't scoped
  // to opportunities the user can already see, since a show itself isn't
  // opportunity-scoped data -- paired with every not-yet-linked opportunity
  // the user has access to, same visibility rule as startableWhere above
  // (an opportunity gets shown here regardless of its own pipeline stage --
  // linking it to a show is what MAKES it eligible per
  // canStartArtworkOnboarding, not a result of already being eligible).
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

  // ESCALATED gets its own section below rather than folding into this
  // count -- it needs a manual resolution step, not just a look.
  const reviewOrders = orders.filter((o) => o.status === "UNDER_ART_REVIEW" || o.status === "EXPO_PROOF_CHECK");
  const escalatedOrders = orders.filter((o) => o.status === "ESCALATED");
  // Same SLA rule artwork/page.tsx already uses (EXPO_PROOF_CHECK only) --
  // not a new/wider definition of "overdue."
  const slaOverdueOrders = orders.filter(
    (o) => o.status === "EXPO_PROOF_CHECK" && o.slaDueAt != null && o.slaDueAt < now,
  );
  // The overdue ones already have their own section directly above this
  // one -- listing them twice makes the page look busier than the work is.
  const overdueIds = new Set(slaOverdueOrders.map((o) => o.id));
  const reviewOnTimeOrders = reviewOrders.filter((o) => !overdueIds.has(o.id));
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
    tabParam === "production" ? "production" : tabParam === "department" && canSeeOversight ? "department" : "today";

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

  const today = new Date();
  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;
  // The one number the hero promises: every piece of work actually waiting
  // on this department right now.
  const needsYou =
    escalatedOrders.length + reviewOrders.length + stalledRejections.length + needsPostShowReviewCount;

  const tabHref = (key: GraphicsTabKey) => `/departments/graphics?tab=${key}`;
  const tabs: DashTab[] = [
    { key: "today", label: "Today", count: needsYou, href: tabHref("today"), active: tab === "today" },
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

  const subgreeting =
    needsYou === 0
      ? "Nothing is waiting on Graphics right now."
      : `${needsYou} thing${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} Graphics today.`;

  // The dot marks a piece assigned to THIS user specifically (via
  // designerId) -- visible on every tab, so a producer scanning
  // department-wide urgent items can still spot their own at a glance.
  function orderTitle(order: GraphicsOrder) {
    const name = order.opportunity ? order.opportunity.company.name : "Show piece";
    return (
      <span className="flex items-center gap-2">
        {order.designerId === currentUserId && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--dash-teal)]" title="Assigned to you" />
        )}
        {name}
      </span>
    );
  }
  function orderSub(order: GraphicsOrder) {
    const showName = order.opportunity ? order.opportunity.showName : order.show?.name;
    return [showName, order.jobCode].filter(Boolean).join(" · ");
  }
  function queueSection(
    title: string,
    rows: { order: GraphicsOrder; right: React.ReactNode }[],
    empty: string,
    link?: { href: string; label: string },
  ) {
    return (
      <DashSection title={`${title} (${rows.length})`} link={link}>
        {rows.length === 0 ? (
          <DashEmpty>{empty}</DashEmpty>
        ) : (
          <DashCard>
            {rows.slice(0, QUEUE_ROWS).map(({ order, right }) => (
              <DashRow
                key={order.id}
                href={`/artwork/${order.id}`}
                title={orderTitle(order)}
                sub={orderSub(order)}
                right={right}
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

  return (
    <DashboardShell
      id="forgeos-graphics"
      today={today}
      firstName={firstName}
      subgreeting={subgreeting}
      quickActions={quickActions}
      tabs={tabs}
    >
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
                { value: String(reviewOrders.length), label: "Awaiting review", href: "/artwork" },
                { value: String(slaOverdueOrders.length), label: "SLA overdue", href: "/artwork" },
                { value: String(inFlightOrders.length), label: "In flight", href: "/departments/graphics/log" },
                { value: String(deliveredThisWeek.length), label: "Delivered this week", href: "/departments/graphics/log" },
                {
                  value: String(needsPostShowReviewCount),
                  label: "Post-show to review",
                  href: "/departments/graphics/post-show",
                },
              ]}
            />
          </div>

          {escalatedOrders.length > 0 &&
            queueSection(
              "ESCALATED — NEEDS MANUAL RESOLUTION",
              escalatedOrders.map((order) => ({ order, right: <DashChip tone="critical">Escalated</DashChip> })),
              "",
            )}

          {slaOverdueOrders.length > 0 &&
            queueSection(
              "SLA OVERDUE",
              slaOverdueOrders.map((order) => ({
                order,
                right: (
                  <DashChip tone="critical">
                    {Math.max(1, Math.floor((now.getTime() - order.slaDueAt!.getTime()) / DAY_MS))}d over
                  </DashChip>
                ),
              })),
              "",
              { href: "/artwork", label: "Artwork queue" },
            )}

          {queueSection(
            "AWAITING REVIEW",
            reviewOnTimeOrders.map((order) => ({
              order,
              right: (
                <DashChip tone={order.status === "EXPO_PROOF_CHECK" ? "info" : "neutral"}>
                  {order.status === "EXPO_PROOF_CHECK" ? "Proof check" : "Art review"}
                </DashChip>
              ),
            })),
            "Nothing is sitting in review.",
            { href: "/artwork", label: "Artwork queue" },
          )}

          {queueSection(
            `STARTING SOON — NEXT ${UPCOMING_SHOW_WINDOW_DAYS} DAYS`,
            upcomingShowOrders.map((order) => {
              const daysUntil = Math.ceil((eventStartDateOf(order)!.getTime() - now.getTime()) / DAY_MS);
              return {
                order,
                right: (
                  <DashChip tone={daysUntil <= 3 ? "critical" : "info"}>
                    {daysUntil === 0 ? "Today" : `${daysUntil}d`}
                  </DashChip>
                ),
              };
            }),
            "Nothing with an artwork order in flight is starting soon.",
            { href: "/shows", label: "All shows" },
          )}

          {queueSection(
            "AWAITING CLIENT RESUBMISSION",
            stalledRejections.map(({ order, rejectedAt }) => ({
              order,
              right: (
                <DashChip tone="neutral">
                  {Math.floor((now.getTime() - rejectedAt.getTime()) / DAY_MS)}d since rejected
                </DashChip>
              ),
            })),
            "No rejected submissions have been sitting for a while.",
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
    </DashboardShell>
  );
}
