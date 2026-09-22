import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canViewWholeTeam, COLD_DAYS, loadLeaderboard, loadSalesOverview, type ClientRow } from "@/lib/sales-analytics";
import { pendingClientReviews } from "@/lib/opportunity-intake";
import { ageLabel } from "@/lib/contact-aging";
import { salesmateRecordUrl } from "@/lib/salesmate-links";
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
import { LocalTimestamp } from "@/components/local-timestamp";
import { AssistantWidget } from "@/components/assistant-widget";
import { ConfirmActivityButton, LogTouchButton, SnoozeButton } from "@/components/sales-row-actions";
import { getDepartmentAssistant } from "@/lib/ai/assistant-registry";
import { listAssistantThreads } from "@/lib/assistant-service";

export const dynamic = "force-dynamic";

function money(value: number, { compact = true } = {}) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    ...(compact ? { notation: "compact" as const } : {}),
  });
}

function percent(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

// Small, quiet buttons that sit inside a dash-row without competing with
// the row's own text.

function clientSub(c: ClientRow) {
  const bits = [`${money(c.lifetimeWonValue)} lifetime`, `${c.wonCount} job${c.wonCount === 1 ? "" : "s"}`];
  if (c.openValue > 0) bits.push(`${money(c.openValue)} open`);
  return bits.join(" · ");
}

// A rep's own book by default; managers and admins can look at anyone, or
// at the whole team (?rep=all). Everyone else is pinned to themselves --
// the selector simply isn't rendered, and an unauthorised ?rep= is ignored
// rather than erroring.
//
// Built on the shared dashboard shell (components/dashboard-shell.tsx) so
// this reads as the same product as the main dashboard: hero greeting,
// quick actions, then sections of rows. What's department-specific is the
// quick actions and which queues appear.
export default async function SalesPage(props: PageProps<"/sales">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const canSeeTeam = canViewWholeTeam(user);

  const params = await props.searchParams;
  const repParam = (Array.isArray(params.rep) ? params.rep[0] : params.rep) ?? "";
  const viewingTeam = canSeeTeam && repParam === "all";
  const ownerUserId = viewingTeam ? null : canSeeTeam && repParam ? repParam : user.id;
  const viewingSelf = ownerUserId === user.id;
  // Tabs, not one long scroll: the landing view is only what needs doing.
  const tabParam = (Array.isArray(params.tab) ? params.tab[0] : params.tab) ?? "today";
  const tab = ["today", "clients", "numbers", "team"].includes(tabParam) ? tabParam : "today";

  // The rep's own assistant, if their department has one registered.
  const assistant = getDepartmentAssistant("SL");

  const [overview, reps, viewed, leaderboard, reviews, assistantThreads] = await Promise.all([
    loadSalesOverview({ ownerUserId }),
    // Deliberately not "every Salesmate user" -- that list includes bots
    // and support logins. Only people who actually own clients or deals.
    canSeeTeam
      ? db.user.findMany({
          where: {
            deletedAt: null,
            OR: [{ salesmateOwnedDeals: { some: { removedAt: null } } }, { salesmateOwnedCompanies: { some: { removedAt: null } } }],
          },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    ownerUserId && !viewingSelf ? db.user.findFirst({ where: { id: ownerUserId }, select: { name: true } }) : Promise.resolve(null),
    canSeeTeam ? loadLeaderboard() : Promise.resolve([]),
    canSeeTeam ? pendingClientReviews() : Promise.resolve([]),
    assistant ? listAssistantThreads(user.id, "SL") : Promise.resolve([]),
  ]);

  const { kpis } = overview;
  const today = new Date();
  const firstName = user.name.trim().split(/\s+/)[0] ?? user.name;
  // The one number the hero promises: everything waiting on this person.
  // Counts, not list lengths -- staleOpenDeals and lapsed are trimmed for
  // display, so adding their .length quietly under-reports for exactly the
  // busiest reps.
  const needsYou =
    overview.goingCold.length +
    overview.scheduled.pastDueCount +
    overview.staleOpenDealCount +
    overview.lapsedCount +
    reviews.length;

  // Each queue shows a handful; the rest is a count, not a scroll.
  const QUEUE_ROWS = 5;
  // Logging a touch or snoozing writes as the signed-in user, so the write
  // buttons only appear on your own book. A manager reading someone else's
  // can still open the client or jump to Salesmate -- they just can't put
  // words in that rep's mouth, or hide a row from a queue that isn't
  // theirs.
  const canAct = viewingSelf;
  const tabHref = (key: string) => `/sales?tab=${key}${repParam ? `&rep=${repParam}` : ""}`;

  const tabs: DashTab[] = [
    { key: "today", label: "Today", count: needsYou, href: tabHref("today"), active: tab === "today" },
    { key: "clients", label: "Clients", count: overview.clients.length, href: tabHref("clients"), active: tab === "clients" },
    { key: "numbers", label: "Numbers", href: tabHref("numbers"), active: tab === "numbers" },
    ...(canSeeTeam
      ? [{ key: "team", label: "Team", count: reviews.length, href: tabHref("team"), active: tab === "team" } satisfies DashTab]
      : []),
  ];

  const quickActions: QuickAction[] = [
    { href: "/opportunities/new", label: "New opportunity", tone: "teal" },
    { href: "/companies", label: "My clients", tone: "navy" },
    { href: "/shows", label: "Shows", tone: "tangerine" },
    { href: "/estimates", label: "Estimates", tone: "gray" },
    { href: "/proposals", label: "Proposals", tone: "tan" },
    { href: "/tasks?view=mine", label: "My tasks", tone: "red" },
  ];

  const whose = viewingTeam ? "the team" : viewed ? viewed.name : "you";
  const subgreeting =
    needsYou === 0
      ? `Nothing is waiting on ${whose} right now.`
      : `${needsYou} thing${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} ${whose} today.`;

  return (
    <DashboardShell
      id="forgeos-sales"
      today={today}
      firstName={firstName}
      subgreeting={subgreeting}
      quickActions={quickActions}
      tabs={tabs}
    >
      {canSeeTeam && (
        <div className="dash-section">
          <div className="dash-section-head">
            <h2 className="dash-section-title">VIEWING</h2>
          </div>
          <DashCard>
            <form action="/sales" className="flex flex-wrap items-center gap-2 px-5 py-3">
              {/* Keep the tab you're on when switching whose book you're looking at. */}
              <input type="hidden" name="tab" value={tab} />
              <select
                name="rep"
                defaultValue={viewingTeam ? "all" : (ownerUserId ?? user.id)}
                className="rounded-md border border-[color:var(--dash-border)] bg-transparent px-3 py-1.5 text-sm"
              >
                <option value={user.id}>My book</option>
                <option value="all">Whole team</option>
                {reps
                  .filter((r) => r.id !== user.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
              <button type="submit" className="dash-qa dash-c-navy">
                <span className="dash-dot" />
                View
              </button>
            </form>
          </DashCard>
        </div>
      )}

      {canSeeTeam && reviews.length > 0 && (tab === "today" || tab === "team") && (
        <DashSection title={`CLIENT REVIEWS TO SCHEDULE (${reviews.length})`}>
          <DashCard>
            {reviews.map((r) => (
              <DashRow
                key={r.id}
                title={`${r.company.name} — ${r.showName}`}
                sub={
                  <>
                    submitted by {r.intakeSubmittedBy?.name ?? "a rep"} {ageLabel(r.intakeSubmittedAt)}
                    {r.boothSize ? ` · ${r.boothSize}` : ""}
                    {r.designerId && r.estimatorId ? " · team assigned" : " · needs designer + estimator"}
                  </>
                }
                right={r.reviewMeetingAt ? <DashChip tone="info">meeting set</DashChip> : <DashChip tone="critical">no meeting yet</DashChip>}
                actions={<DashRowAction href={`/opportunities/${r.id}/intake`}>Schedule &amp; assign</DashRowAction>}
              />
            ))}
          </DashCard>
        </DashSection>
      )}

      {tab === "today" && (
      <DashSection
        title={`FOLLOW UP — QUIET ${COLD_DAYS}+ DAYS (${overview.goingCold.length})`}
        link={{ href: "/companies?stale=90&sort=contacted", label: "All clients" }}
      >
        {overview.goingCold.length === 0 ? (
          <DashEmpty>
            No client with won or open work has gone quiet.
            {overview.quietProspects > 0 && ` ${overview.quietProspects} prospect(s) with no history are also quiet.`}
          </DashEmpty>
        ) : (
          <DashCard>
            {overview.goingCold.slice(0, QUEUE_ROWS).map((c) => {
              const salesmate = c.salesmateCompanyId ? salesmateRecordUrl("company", c.salesmateCompanyId) : "";
              return (
                <DashRow
                  key={c.companyId}
                  title={c.name}
                  sub={clientSub(c)}
                  right={<DashChip tone="critical">{ageLabel(c.lastContactedAt)}</DashChip>}
                  actions={
                    <>
                      {canAct && (
                        <>
                          <LogTouchButton companyId={c.companyId} companyName={c.name} />
                          <SnoozeButton queue="FOLLOW_UP" targetKey={c.companyId} />
                        </>
                      )}
                      <DashRowAction href={`/companies/${c.companyId}`}>Open</DashRowAction>
                      {salesmate && (
                        <DashRowAction href={salesmate} external>
                          Salesmate
                        </DashRowAction>
                      )}
                    </>
                  }
                />
              );
            })}
          </DashCard>
        )}
      </DashSection>

      )}

      {tab === "today" && overview.scheduled.pastDueCount > 0 && (
      <DashSection title={`CONFIRM — PAST DUE (${overview.scheduled.pastDueCount})`}>
        {overview.scheduled.pastDue.length === 0 ? (
          <DashEmpty>Nothing past due.</DashEmpty>
        ) : (
          <DashCard>
            {overview.scheduled.pastDue.slice(0, QUEUE_ROWS).map((a) => {
              const salesmate = salesmateRecordUrl("activity", a.salesmateId);
              return (
                <DashRow
                  key={a.salesmateId}
                  title={a.title}
                  sub={
                    <>
                      {a.type}
                      {a.companyName ? ` · ${a.companyName}` : " · no client linked"}
                    </>
                  }
                  right={<DashChip tone="critical">{a.daysOverdue}d ago</DashChip>}
                  actions={
                    <>
                      {canAct && (
                        <>
                          <ConfirmActivityButton salesmateId={a.salesmateId} />
                          <SnoozeButton queue="PAST_DUE" targetKey={a.salesmateId} />
                        </>
                      )}
                      {a.companyId && <DashRowAction href={`/companies/${a.companyId}`}>Open</DashRowAction>}
                      {salesmate && (
                        <DashRowAction href={salesmate} external>
                          Salesmate
                        </DashRowAction>
                      )}
                    </>
                  }
                />
              );
            })}
          </DashCard>
        )}
      </DashSection>

      )}

      {tab === "today" && overview.staleOpenDealCount > 0 && (
      <DashSection
        title={`PUSH — STALLED DEALS (${overview.staleOpenDealCount})`}
        link={overview.staleOpenDealCount > QUEUE_ROWS ? { href: tabHref("clients"), label: "All clients" } : undefined}
      >
        {overview.staleOpenDeals.length === 0 ? (
          <DashEmpty>Every open deal has had recent activity.</DashEmpty>
        ) : (
          <DashCard>
            {overview.staleOpenDeals.slice(0, QUEUE_ROWS).map((d) => {
              const salesmate = salesmateRecordUrl("deal", d.salesmateId);
              return (
                <DashRow
                  key={d.salesmateId}
                  title={d.title}
                  sub={
                    <>
                      {d.companyName ?? "No linked client"}
                      {d.stage ? ` · ${d.stage}` : ""}
                      {d.daysInStage != null ? ` · ${d.daysInStage}d in stage` : ""}
                      {d.daysQuiet < 0 ? " · no activity logged" : ` · quiet ${d.daysQuiet}d`}
                    </>
                  }
                  right={<DashChip tone="neutral">{money(d.value)}</DashChip>}
                  actions={
                    <>
                      {canAct && (
                        <>
                          {d.companyId && <LogTouchButton companyId={d.companyId} companyName={d.companyName ?? "this client"} />}
                          <SnoozeButton queue="STALLED_DEAL" targetKey={d.salesmateId} />
                        </>
                      )}
                      {salesmate && (
                        <DashRowAction href={salesmate} external>
                          Salesmate
                        </DashRowAction>
                      )}
                      <DashRowAction href={`/opportunities/new${d.companyId ? `?companyId=${d.companyId}` : ""}`}>Start intake</DashRowAction>
                    </>
                  }
                />
              );
            })}
          </DashCard>
        )}
      </DashSection>

      )}

      {tab === "today" && overview.lapsedCount > 0 && (
      <DashSection title={`WIN BACK — NOT THIS YEAR (${overview.lapsedCount})`}>
        {overview.lapsed.length === 0 ? (
          <DashEmpty>Every past client has bought this year or has something open.</DashEmpty>
        ) : (
          <DashCard>
            {overview.lapsed.slice(0, QUEUE_ROWS).map((c) => (
              <DashRow
                key={c.companyId}
                title={c.name}
                sub={clientSub(c)}
                right={<DashChip tone="neutral">last won {ageLabel(c.lastWonAt)}</DashChip>}
                actions={
                  <>
                    {canAct && (
                      <>
                        <LogTouchButton companyId={c.companyId} companyName={c.name} />
                        <SnoozeButton queue="WIN_BACK" targetKey={c.companyId} />
                      </>
                    )}
                    <DashRowAction href={`/companies/${c.companyId}`}>Open</DashRowAction>
                  </>
                }
              />
            ))}
          </DashCard>
        )}
      </DashSection>

      )}

      {tab === "today" && needsYou === 0 && (
        <DashSection title="NOTHING WAITING">
          <DashEmpty>
            Every client has been contacted, nothing is past due, no deal has stalled. Check the Clients tab for who to
            call next.
          </DashEmpty>
        </DashSection>
      )}

      {tab === "numbers" && (
      <DashSection title="THE BOOK">
        <DashStatStrip
          stats={[
            { value: money(kpis.wonValueYtd), label: "Won this year" },
            { value: money(kpis.wonValue12mo), label: `Won 12mo (${kpis.wonCount12mo})` },
            { value: money(kpis.openValue), label: `Open (${kpis.openCount})` },
            { value: String(kpis.activeClients), label: "Active clients" },
            { value: percent(kpis.winRateCount), label: "Win rate" },
            { value: money(kpis.avgWonDealValue), label: "Avg won deal" },
          ]}
        />
      </DashSection>

      )}

      {tab === "clients" && (
      <DashSection title="CLIENTS BY VALUE" link={{ href: "/companies?sort=worked", label: "All clients" }}>
        {overview.clients.length === 0 ? (
          <DashEmpty>No clients on this book yet.</DashEmpty>
        ) : (
          <DashCard>
            {overview.clients.slice(0, 25).map((c) => (
              <DashRow
                key={c.companyId}
                href={`/companies/${c.companyId}`}
                title={c.name}
                sub={
                  <>
                    {clientSub(c)} · contacted {ageLabel(c.lastContactedAt).toLowerCase()} · worked with{" "}
                    {ageLabel(c.lastWorkedWithAt).toLowerCase()}
                    {c.proposalsSent > 0 ? ` · ${c.proposalsSigned}/${c.proposalsSent} proposals signed` : ""}
                  </>
                }
                right={<DashChip tone="good">{money(c.lifetimeWonValue)}</DashChip>}
              />
            ))}
          </DashCard>
        )}
      </DashSection>

      )}

      {(tab === "today" || tab === "clients") && (
      <DashSection title={`COMING UP (${overview.scheduled.upcomingCount})`}>
        {overview.scheduled.upcoming.length === 0 ? (
          <DashEmpty>Nothing scheduled.</DashEmpty>
        ) : (
          <DashCard>
            {overview.scheduled.upcoming.slice(0, QUEUE_ROWS).map((a) => (
              <DashRow
                key={a.salesmateId}
                title={a.title}
                sub={
                  <>
                    {a.type}
                    {a.companyName ? ` · ${a.companyName}` : " · no client linked"}
                  </>
                }
                right={
                  a.dueAt ? (
                    <DashChip tone="info">
                      <LocalTimestamp iso={a.dueAt} timeStyle={undefined} />
                    </DashChip>
                  ) : null
                }
              />
            ))}
          </DashCard>
        )}
      </DashSection>

      )}

      {tab === "numbers" && overview.touchHistory.since && (
        <DashSection title="CONTACT RECORDED">
          <DashStatStrip
            stats={[
              { value: String(overview.touchHistory.last30Days), label: "Last 30 days" },
              { value: String(overview.touchHistory.last90Days), label: "Last 90 days" },
            ]}
          />
        </DashSection>
      )}

      {canSeeTeam && tab === "team" && leaderboard.length > 0 && (
        <DashSection title="TEAM — LAST 12 MONTHS">
          <DashCard>
            {leaderboard.map((r) => (
              <DashRow
                key={r.userId ?? "former"}
                href={r.userId ? `/sales?rep=${r.userId}` : undefined}
                title={r.name}
                sub={
                  <>
                    {r.wonCount12mo} job{r.wonCount12mo === 1 ? "" : "s"} · {money(r.openValue)} open · win rate{" "}
                    {percent(r.winRateCount)} · {r.clients} client{r.clients === 1 ? "" : "s"} · {r.coldClients} going cold
                    {r.medianDaysSinceContact != null ? ` · typically ${r.medianDaysSinceContact}d since contact` : ""}
                  </>
                }
                right={<DashChip tone={r.isFormer ? "neutral" : "good"}>{money(r.wonValue12mo)}</DashChip>}
              />
            ))}
          </DashCard>
        </DashSection>
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
