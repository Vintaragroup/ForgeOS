import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import {
  startArtworkOrderFromDashboardAction,
  linkOpportunityToShowFromDashboardAction,
  onboardNewClientFromDashboardAction,
} from "./actions";
import { PageHeader, Card, Stat, StatusChip, EmptyState, SelectField, Field, Button } from "@/components/ui";
import { CompanyFieldWithCreate } from "@/components/company-field-with-create";

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

export default async function GraphicsHomePage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { opportunityId: selectedOpportunityId } = await searchParams;

  // Gates "Onboard a new client" below -- matches
  // onboardNewClientFromDashboardAction's own check exactly, so the form
  // never renders somewhere it would just throw on submit.
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  const canOnboardNewClient = isAdmin || canAccessArtworkOrdersViaDepartment(user);

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

  // "Link an opportunity to a show" (below): every show in the system --
  // this isn't scoped to opportunities the user can already see, since a
  // show itself isn't opportunity-scoped data -- paired with every
  // not-yet-linked opportunity the user has access to, same visibility rule
  // as startableWhere above (an opportunity gets shown here regardless of
  // its own pipeline stage -- linking it to a show is what MAKES it
  // eligible per canStartArtworkOnboarding, not a result of already being
  // eligible).
  const [shows, unassignedOpportunities, companies] = await Promise.all([
    // Soonest-first -- the show someone's actually about to work is the one
    // that matters most in a picker, not alphabetical order. A show with no
    // event date set yet (nulls) sorts last, after every dated show.
    db.show.findMany({
      where: { deletedAt: null },
      orderBy: { eventStartDate: { sort: "asc", nulls: "last" } },
      select: { id: true, name: true },
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
  ]);

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
        {canOnboardNewClient && (
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Onboard a new client
            </h2>
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
          </Card>
        )}

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Start an artwork order
          </h2>
          {startableOpportunities.length === 0 ? (
            <EmptyState message="No opportunity is ready to start an artwork order right now -- won a deal, or linked one to a show, to see it here." />
          ) : (
            <>
              <form method="GET" className="flex flex-wrap items-end gap-3">
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
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Link an opportunity to a show
          </h2>
          {shows.length === 0 ? (
            <EmptyState message="No shows exist yet -- start one from Pipeline → Shows." />
          ) : unassignedOpportunities.length === 0 ? (
            <EmptyState message="No unassigned opportunity is available to link to a show right now." />
          ) : (
            <form action={linkOpportunityToShowFromDashboardAction} className="flex flex-wrap items-end gap-3">
              <div className="min-w-56">
                <SelectField
                  label="Show"
                  name="showId"
                  defaultValue={defaultShowId}
                  options={[
                    { value: "", label: "Select a show…" },
                    ...shows.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                  required
                />
              </div>
              <div className="min-w-64">
                <SelectField
                  label="Opportunity"
                  name="opportunityId"
                  options={[
                    { value: "", label: "Select an opportunity…" },
                    ...unassignedOpportunities.map((o) => ({
                      value: o.id,
                      label: `${o.company.name} — ${o.showName}`,
                    })),
                  ]}
                  required
                />
              </div>
              <Button variant="secondary">Link</Button>
            </form>
          )}
        </Card>

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
