import Link from "next/link";
import { redirect } from "next/navigation";
import { getDashboardData, type UpcomingDeadline } from "@/lib/dashboard";
import { getAdminAnalytics, getRecentAnalysisFailures } from "@/lib/admin-analytics";
import {
  getUpcomingWithOverdue,
  isOverdueItem,
  utcToday,
  CALENDAR_ITEM_TYPE_LABELS,
  WORK_ORDER_ITEM_TYPES,
  RFP_ITEM_TYPES,
  type CalendarItemTone,
} from "@/lib/calendar";
import { getTasksForUser } from "@/lib/tasks";
import { db } from "@/lib/db";
import { loadCompanyAging } from "@/lib/company-aging";
import { ageLabel, isStale } from "@/lib/contact-aging";
import { getCurrentUser } from "@/lib/auth";
import { DEPARTMENT_HOME } from "@/lib/department-home";
import { recordDeadlineActionAction, routeDashboardQueryAction } from "./dashboard-actions";
import { Button } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { CLOSE_REASON_LABELS } from "@/components/stage-change-fields";

export const dynamic = "force-dynamic";

// Maps a CalendarItem's tone (the same vocabulary /calendar's own
// TONE_PILL uses) to one of this dashboard's dash-chip color variants --
// "warning" reuses dash-info (tangerine/tan) since that's the dash system's
// only amber slot; "info" gets its own dash-accent (navy) variant instead
// of colliding with it, since /calendar's "info" tone is navy-based, not
// tangerine-based.
const DASH_CHIP_TONE: Record<CalendarItemTone, string> = {
  neutral: "dash-neutral",
  info: "dash-accent",
  warning: "dash-info",
  good: "dash-good",
  critical: "dash-critical",
};

const STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  ESTIMATING: "Estimating",
  WON: "Won",
  LOST: "Lost",
};

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  ADMIN: "Admin",
  EMPLOYEE: "Employee",
};

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function fmtPct(pct: number | null) {
  return pct === null ? "—" : `${pct.toFixed(0)}%`;
}

function fmtUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// AI usage costs are often sub-dollar (a single document analysis can be
// a few cents) -- fmtUsd's whole-dollar rounding would show "$0" for
// almost every real call, defeating a cost-awareness feature.
function fmtAiCost(n: number) {
  return `~$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function greetingWord(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function ProposalStatusChip({ sentAt, signedAt }: { sentAt: Date | null; signedAt: Date | null }) {
  if (signedAt) return <span className="dash-chip dash-good">Signed</span>;
  if (sentAt) return <span className="dash-chip dash-info">Sent</span>;
  return <span className="dash-chip dash-neutral">Draft</span>;
}

// Deadlines arrive sorted by date -- grouping preserves that order, so the
// opportunity with the soonest deadline still lists first, but everything
// belonging to one job now reads together instead of interleaving by date.
function groupDeadlinesByOpportunity(deadlines: UpcomingDeadline[]) {
  const groups = new Map<string, { opportunityId: string; opportunityName: string; deadlines: UpcomingDeadline[] }>();
  for (const deadline of deadlines) {
    const group = groups.get(deadline.opportunityId);
    if (group) {
      group.deadlines.push(deadline);
    } else {
      groups.set(deadline.opportunityId, {
        opportunityId: deadline.opportunityId,
        opportunityName: deadline.opportunityName,
        deadlines: [deadline],
      });
    }
  }
  return [...groups.values()];
}

// Redesigned per the Claude/ChatGPT-desktop-landing exploration (see
// project notes): pipeline first (the state of the world before the
// greeting), then a centered hero -- real ExpoCCI logo, a time-of-day
// greeting, and a "what would you like to tackle today" bar. That bar is
// a router, not a live conversation -- routeDashboardQueryAction's own
// header comment explains why (ChatThread.opportunityId is required and
// unique; there's no account-wide assistant yet). Everything below the
// hero is the same real data this page always showed, restyled with the
// dash-* classes in globals.css so the whole page (not just the hero)
// respects the light/dark toggle -- deliberately NOT using the shared
// Card/Stat/StatusChip components here, since making those theme-aware
// would ripple into every other page that uses them, well beyond the
// scope of this one page's redesign.
// Salesmate customers nobody has contacted in GOING_COLD_DAYS+ days (or
// ever), oldest first -- see company-aging.ts for where the dates come
// from. Customers only: a lead going quiet is normal, a paying client
// going quiet is the one to act on.
const GOING_COLD_DAYS = 90;
const GOING_COLD_SHOWN = 6;

async function getGoingColdCustomers() {
  const agingById = await loadCompanyAging();
  const coldIds = [...agingById.entries()]
    .filter(([, a]) => a.salesmateType === "Customer" && isStale(a.lastContacted?.at, GOING_COLD_DAYS))
    .sort(([, a], [, b]) => (a.lastContacted?.at.getTime() ?? -Infinity) - (b.lastContacted?.at.getTime() ?? -Infinity))
    .map(([id]) => id);
  const companies = await db.company.findMany({
    where: { id: { in: coldIds.slice(0, GOING_COLD_SHOWN) }, deletedAt: null },
    select: { id: true, name: true },
  });
  const byId = new Map(companies.map((c) => [c.id, c]));
  return {
    total: coldIds.length,
    companies: coldIds
      .slice(0, GOING_COLD_SHOWN)
      .flatMap((id) => (byId.has(id) ? [{ company: byId.get(id)!, aging: agingById.get(id)! }] : [])),
  };
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  // Admins always keep the generic cross-app dashboard regardless of their
  // own department -- this check runs before any dashboard data is
  // fetched, so a redirected department user never pays for those queries.
  if (!isAdmin && user.departmentCode && DEPARTMENT_HOME[user.departmentCode]) {
    redirect(DEPARTMENT_HOME[user.departmentCode]);
  }

  const today = new Date();
  const calendarToday = utcToday();
  const [{ pipeline, upcomingDeadlines, recentProposals, flaggedForReview }, rawCalendarItems, myTasks, goingCold] = await Promise.all([
    getDashboardData(user),
    getUpcomingWithOverdue(user, calendarToday, 7),
    getTasksForUser(user, { mineOnly: true, includeCompleted: false }),
    getGoingColdCustomers(),
  ]);
  // WorkOrder milestones and RFP key dates are already covered by
  // UPCOMING DEADLINES below (same fields, via dashboard.ts's own
  // DeadlineKind) -- excluded here so the two sections don't list the
  // same deadline twice. /calendar itself keeps every type; this only
  // trims the Dashboard widget.
  const calendarItems = rawCalendarItems.filter(
    (item) => !WORK_ORDER_ITEM_TYPES.includes(item.type) && !RFP_ITEM_TYPES.includes(item.type),
  );
  const adminStats = isAdmin ? await getAdminAnalytics() : null;
  // Stricter than isAdmin above -- a real error message (stack-adjacent
  // detail from an AI provider call) is more internal than the aggregate
  // counts plain ADMIN already sees, so this one section is SUPER_ADMIN
  // only. See getRecentAnalysisFailures's own comment.
  const isSuperAdmin = user.systemRole === "SUPER_ADMIN";
  const analysisFailures = isSuperAdmin ? await getRecentAnalysisFailures() : null;

  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;

  return (
    <div id="forgeos-dashboard" className="dash dash-full-bleed -my-8">
      <div className="dash-hero">
        {/* No logo here -- AppNav's header above already shows it; repeating
            it in the hero read as two logos stacked on top of each other. */}
        <div className="dash-hero-top">
          <span className="dash-clock">
            {today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </span>
          <ThemeToggle targetId="forgeos-dashboard" />
        </div>

        <div className="dash-hero-content">
          <h1 className="dash-greeting">
            {greetingWord(today.getHours())}, <span className="dash-accent">{firstName}.</span>
          </h1>
          <p className="dash-subgreeting">What would you like to tackle today?</p>

          <form action={routeDashboardQueryAction} className="dash-command">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <label htmlFor="dash-query" className="sr-only">
              Search or ask about an opportunity, estimate, or company
            </label>
            <input
              id="dash-query"
              name="query"
              type="text"
              autoComplete="off"
              placeholder="Search or ask about an opportunity, estimate, company…"
            />
            <button type="submit">Go</button>
          </form>

          <div className="dash-quick-actions">
            <Link className="dash-qa dash-c-teal" href="/opportunities/new">
              <span className="dash-dot" />
              New opportunity
            </Link>
            <Link className="dash-qa dash-c-tangerine" href="/estimates">
              <span className="dash-dot" />
              Estimates
            </Link>
            <Link className="dash-qa dash-c-navy" href="/proposals">
              <span className="dash-dot" />
              Proposals
            </Link>
            <Link className="dash-qa dash-c-gray" href="/catalog">
              <span className="dash-dot" />
              Catalog
            </Link>
            <Link className="dash-qa dash-c-tan" href="/reports">
              <span className="dash-dot" />
              Reports
            </Link>
            <Link className="dash-qa dash-c-red" href="/tasks?view=mine">
              <span className="dash-dot" />
              {myTasks.length > 0 ? `My Tasks (${myTasks.length})` : "My Tasks"}
            </Link>
          </div>
        </div>
      </div>

      <div className="dash-wrap">
        <div className="dash-section">
          <div className="dash-section-head">
            <h2 className="dash-section-title">PIPELINE</h2>
            <Link href="/opportunities" className="dash-section-link">
              All opportunities →
            </Link>
          </div>
          <div className="dash-card dash-pipeline-card">
            {Object.entries(STAGE_LABELS).map(([stage, label]) => (
              <Link key={stage} href={`/opportunities?stage=${stage}`} className="dash-strip-stat">
                <span className="n">{pipeline.byStage[stage] ?? 0}</span>
                <span className="l">{label}</span>
              </Link>
            ))}
          </div>
        </div>

        <div className="dash-section">
          <div className="dash-section-head">
            <h2 className="dash-section-title">CALENDAR</h2>
            <Link href="/calendar" className="dash-section-link">
              View calendar →
            </Link>
          </div>
          {calendarItems.length === 0 ? (
            <div className="dash-card">
              <div className="dash-row">
                <div>
                  <div className="dash-row-title">Nothing on the calendar in the next 7 days</div>
                  <div className="dash-row-sub">Show dates, milestones, and reminders will show up here.</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="dash-card">
              {calendarItems.map((item) => (
                <Link key={item.id} href={item.href} className="dash-row" style={{ color: "inherit", textDecoration: "none" }}>
                  <div>
                    <div className="dash-row-title">{item.title}</div>
                    <span className={`dash-chip ${DASH_CHIP_TONE[item.tone]}`}>{CALENDAR_ITEM_TYPE_LABELS[item.type]}</span>
                  </div>
                  {isOverdueItem(item, calendarToday) ? (
                    <span className="dash-chip dash-critical">Overdue — {fmtDate(item.dateStart)}</span>
                  ) : (
                    <span className="dash-row-date">{fmtDate(item.dateStart)}</span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="dash-section">
          <div className="dash-section-head">
            <h2 className="dash-section-title">UPCOMING DEADLINES</h2>
            <span className="dash-section-link">Next 30 days</span>
          </div>
          {upcomingDeadlines.length === 0 ? (
            <div className="dash-card">
              <div className="dash-row">
                <div>
                  <div className="dash-row-title">Nothing due in the next 30 days</div>
                  <div className="dash-row-sub">Once a job is won, its production timeline shows up here.</div>
                </div>
                <Link href="/opportunities" className="dash-section-link">
                  View opportunities →
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {groupDeadlinesByOpportunity(upcomingDeadlines).map((group) => (
                <div key={group.opportunityId} className="dash-card">
                  <Link href={`/opportunities/${group.opportunityId}`} className="dash-card-head" style={{ display: "block" }}>
                    {group.opportunityName}
                  </Link>
                  {group.deadlines.map((deadline) => (
                    <div key={deadline.key} className="dash-row">
                      <Link href={deadline.href} className="min-w-0 flex-1 hover:underline" style={{ color: "inherit", textDecoration: "none" }}>
                        <div className="dash-row-title">{deadline.kind}</div>
                        {deadline.label && <div className="dash-row-sub truncate">{deadline.label}</div>}
                      </Link>
                      <div className="flex flex-none items-center gap-3">
                        {deadline.overdue ? (
                          <span className="dash-chip dash-critical">Overdue — {fmtDate(deadline.date)}</span>
                        ) : deadline.kind === "RFP milestone" && deadline.date < new Date() ? (
                          <span className="dash-chip dash-neutral">Passed — {fmtDate(deadline.date)}</span>
                        ) : (
                          <span className="dash-row-date">{fmtDate(deadline.date)}</span>
                        )}
                        {deadline.action && (
                          <form
                            action={recordDeadlineActionAction.bind(
                              null,
                              group.opportunityId,
                              deadline.dedupeKey,
                              deadline.action.status,
                            )}
                          >
                            <Button variant="secondary">{deadline.action.label}</Button>
                          </form>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dash-section">
          <div className="dash-section-head">
            <h2 className="dash-section-title">RECENT PROPOSALS</h2>
            {recentProposals.length > 0 && (
              <Link href="/proposals" className="dash-section-link">
                View all →
              </Link>
            )}
          </div>
          {recentProposals.length === 0 ? (
            <div className="dash-card">
              <div className="dash-row">
                <div>
                  <div className="dash-row-title">No proposals yet</div>
                  <div className="dash-row-sub">Generate one from an approved estimate version.</div>
                </div>
                <Link href="/estimates" className="dash-section-link">
                  View estimates →
                </Link>
              </div>
            </div>
          ) : (
            <div className="dash-card">
              {recentProposals.map((proposal) => {
                const opportunity = proposal.estimateVersion.estimate.opportunity;
                return (
                  <Link key={proposal.id} href={`/proposals/${proposal.id}`} className="dash-row">
                    <div>
                      <div className="dash-row-title">{opportunity.showName}</div>
                      <div className="dash-row-sub">{opportunity.company.name}</div>
                    </div>
                    <ProposalStatusChip sentAt={proposal.sentAt} signedAt={proposal.signedAt} />
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {goingCold.total > 0 && (
          <div className="dash-section">
            <div className="dash-section-head">
              <h2 className="dash-section-title">GOING COLD</h2>
              <Link href={`/companies?type=Customer&stale=${GOING_COLD_DAYS}&sort=contacted`} className="dash-section-link">
                All {goingCold.total} →
              </Link>
            </div>
            <div className="dash-card">
              {goingCold.companies.map(({ company, aging }) => (
                <Link key={company.id} href={`/companies/${company.id}`} className="dash-row">
                  <div>
                    <div className="dash-row-title">{company.name}</div>
                    <div className="dash-row-sub">
                      {aging.lastContacted
                        ? `Customer not contacted in ${GOING_COLD_DAYS}+ days${aging.lastContacted.by ? ` — last by ${aging.lastContacted.by}` : ""}`
                        : "Customer with no contact logged in Salesmate"}
                    </div>
                  </div>
                  <span className={`dash-chip ${aging.lastContacted ? "dash-critical" : "dash-neutral"}`}>
                    {ageLabel(aging.lastContacted?.at)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {flaggedForReview.length > 0 && (
          <div className="dash-section">
            <div className="dash-section-head">
              <h2 className="dash-section-title">FLAGGED FOR REVIEW</h2>
            </div>
            <div className="dash-card">
              {flaggedForReview.map((item) => (
                <Link key={item.key} href={item.href} className="dash-row">
                  <div>
                    <div className="dash-row-title">{item.groupLabel}</div>
                    <div className="dash-row-sub">
                      {item.opportunityName} — excluded from totals, needs review
                    </div>
                  </div>
                  <span className="dash-chip dash-neutral">{fmtUsd(item.cost)}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {analysisFailures && analysisFailures.length > 0 && (
          <div className="dash-section">
            <div className="dash-section-head">
              <h2 className="dash-section-title">FAILED ANALYSES</h2>
            </div>
            <div className="dash-card">
              {analysisFailures.map((doc) => (
                <Link
                  key={doc.id}
                  href={`/opportunities/${doc.opportunityId}?tab=documents`}
                  className="dash-row"
                >
                  <div>
                    <div className="dash-row-title">{doc.filename}</div>
                    <div className="dash-row-sub">
                      {doc.opportunity.company.name} — {doc.opportunity.showName}
                      {doc.analysisError ? ` — ${doc.analysisError}` : " — no error message recorded"}
                    </div>
                  </div>
                  <span className="dash-chip dash-critical">
                    {doc.analysisErrorAt ? fmtDate(doc.analysisErrorAt) : "date unknown"}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {adminStats && (
          <div className="dash-admin">
            <div className="dash-admin-eyebrow">Admin overview</div>

            <div className="dash-subhead">Estimates &amp; proposals</div>
            <div className="dash-stat-grid">
              <div className="dash-stat">
                <div className="n">{adminStats.estimates.current}</div>
                <div className="l">Active estimate versions</div>
              </div>
              <div className="dash-stat">
                <div className="n">{adminStats.estimates.locked}</div>
                <div className="l">Locked</div>
              </div>
              <div className="dash-stat">
                <div className="n">{adminStats.estimates.approved}</div>
                <div className="l">Approved</div>
              </div>
              <div className="dash-stat">
                <div className="n">{adminStats.proposals.total}</div>
                <div className="l">Proposals generated</div>
              </div>
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--dash-text-soft)" }}>
              {adminStats.proposals.sent} sent, {adminStats.proposals.signed} signed — sign rate{" "}
              {fmtPct(adminStats.proposals.signRatePct)}
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--dash-text-soft)" }}>
              Win rate: {fmtPct(adminStats.pipeline.winRatePct)} ({adminStats.pipeline.closedCount} closed
              opportunit{adminStats.pipeline.closedCount === 1 ? "y" : "ies"})
            </p>
            {Object.keys(adminStats.pipeline.lostReasonCounts).length > 0 && (
              <p className="mt-1 text-sm" style={{ color: "var(--dash-text-soft)" }}>
                Lost to:{" "}
                {Object.entries(adminStats.pipeline.lostReasonCounts)
                  .sort(([, a], [, b]) => b - a)
                  .map(([reason, count]) => `${CLOSE_REASON_LABELS[reason] ?? reason} (${count})`)
                  .join(", ")}
              </p>
            )}

            <div className="dash-subhead">Cost variance</div>
            <div className="dash-stat-grid">
              <div className="dash-stat">
                <div className="n">{adminStats.costVariance.lineItemCount}</div>
                <div className="l">Line items with actuals</div>
              </div>
              <div className="dash-stat">
                <div className="n">{fmtUsd(adminStats.costVariance.estimatedTotal)}</div>
                <div className="l">Estimated</div>
              </div>
              <div className="dash-stat">
                <div className="n">{fmtUsd(adminStats.costVariance.actualTotal)}</div>
                <div className="l">Actual</div>
              </div>
              <div className="dash-stat">
                <div className="n">
                  {adminStats.costVariance.variance >= 0 ? "+" : ""}
                  {fmtUsd(adminStats.costVariance.variance)}
                </div>
                <div className="l">Variance (actual − estimated)</div>
              </div>
            </div>

            <div className="dash-subhead">AI usage</div>
            <div className="dash-stat-grid">
              <div className="dash-stat">
                <div className="n">{adminStats.aiUsage.calls}</div>
                <div className="l">Calls</div>
              </div>
              <div className="dash-stat">
                <div className="n">{adminStats.aiUsage.tokens.toLocaleString()}</div>
                <div className="l">Tokens</div>
              </div>
              <div className="dash-stat">
                <div className="n">{fmtAiCost(adminStats.aiUsage.estimatedCostUsd)}</div>
                <div className="l">Est. cost</div>
              </div>
              <div className="dash-stat">
                <div className="n">{adminStats.aiUsage.drawingAnalyses}</div>
                <div className="l">Drawing analyses</div>
              </div>
            </div>

            <div className="dash-subhead">Users</div>
            <div className="dash-stat-grid">
              <div className="dash-stat">
                <div className="n">{adminStats.users.total}</div>
                <div className="l">Total</div>
              </div>
              {Object.entries(ROLE_LABELS).map(([role, label]) => (
                <div key={role} className="dash-stat">
                  <div className="n">{adminStats.users.byRole[role] ?? 0}</div>
                  <div className="l">{label}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-sm">
              <Link href="/admin/users" style={{ color: "var(--dash-navy)" }} className="hover:underline">
                Manage users →
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
