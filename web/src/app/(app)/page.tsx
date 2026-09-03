import Link from "next/link";
import { redirect } from "next/navigation";
import { getDashboardData, type UpcomingDeadline } from "@/lib/dashboard";
import { getAdminAnalytics } from "@/lib/admin-analytics";
import { getCurrentUser } from "@/lib/auth";
import { recordDeadlineActionAction, routeDashboardQueryAction } from "./dashboard-actions";
import { Button } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { CLOSE_REASON_LABELS } from "@/components/stage-change-fields";

export const dynamic = "force-dynamic";

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
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { pipeline, upcomingDeadlines, recentProposals, flaggedForReview } = await getDashboardData(user);
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  const adminStats = isAdmin ? await getAdminAnalytics() : null;

  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;
  const today = new Date();

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
