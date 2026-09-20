import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canViewWholeTeam, loadLeaderboard, loadSalesOverview, COLD_DAYS } from "@/lib/sales-analytics";
import { Card, EmptyState, PageHeader, Stat, StatusChip } from "@/components/ui";
import { AgingChip } from "@/components/aging-chip";
import { ageLabel } from "@/lib/contact-aging";

export const dynamic = "force-dynamic";

function money(value: number, { compact = false } = {}) {
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

// A rep's own book by default; managers and admins can look at anyone, or
// at the whole team (?rep=all). Everyone else is pinned to themselves --
// the selector simply isn't rendered, and an unauthorised ?rep= is ignored
// rather than erroring.
export default async function SalesPage(props: PageProps<"/sales">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const canSeeTeam = canViewWholeTeam(user);

  const params = await props.searchParams;
  const repParam = (Array.isArray(params.rep) ? params.rep[0] : params.rep) ?? "";
  const viewingTeam = canSeeTeam && repParam === "all";
  const ownerUserId = viewingTeam ? null : canSeeTeam && repParam ? repParam : user.id;

  const [overview, reps, viewed, leaderboard] = await Promise.all([
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
    ownerUserId && ownerUserId !== user.id
      ? db.user.findFirst({ where: { id: ownerUserId }, select: { name: true } })
      : Promise.resolve(null),
    canSeeTeam ? loadLeaderboard() : Promise.resolve([]),
  ]);

  const { kpis } = overview;
  const title = viewingTeam ? "Sales — whole team" : viewed ? `Sales — ${viewed.name}` : "My sales";

  return (
    <div>
      <PageHeader
        title={title}
        action={
          canSeeTeam ? (
            <form action="/sales" className="flex items-end gap-2">
              <select
                name="rep"
                defaultValue={viewingTeam ? "all" : (ownerUserId ?? user.id)}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
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
              <button type="submit" className="rounded-md bg-brand-black px-4 py-2 text-sm font-medium text-white hover:bg-brand-navy">
                View
              </button>
            </form>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <Stat value={money(kpis.wonValueYtd, { compact: true })} label="Won this year" />
        </Card>
        <Card className="p-4">
          <Stat value={money(kpis.wonValue12mo, { compact: true })} label={`Won last 12 months (${kpis.wonCount12mo} jobs)`} />
        </Card>
        <Card className="p-4">
          <Stat value={money(kpis.openValue, { compact: true })} label={`Open pipeline (${kpis.openCount} deals)`} />
        </Card>
        <Card className="p-4">
          <Stat value={String(kpis.activeClients)} label="Active clients" />
        </Card>
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <Stat value={percent(kpis.winRateCount)} label="Win rate, by count (12mo)" />
        </Card>
        <Card className="p-4">
          <Stat value={percent(kpis.winRateValue)} label="Win rate, by value (12mo)" />
        </Card>
        <Card className="p-4">
          <Stat value={money(kpis.avgWonDealValue, { compact: true })} label="Average won deal" />
        </Card>
      </div>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold">Needs attention</h2>
        <p className="mb-3 text-sm text-neutral-500">
          Clients ranked by what they&apos;re worth and how long they&apos;ve been quiet ({COLD_DAYS}+ days), then open deals
          nobody has touched in a month.
        </p>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <div className="border-b border-neutral-200 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Going cold ({overview.goingCold.length})
              {overview.quietProspects > 0 && (
                <span className="ml-2 font-normal normal-case text-neutral-400">
                  + {overview.quietProspects} quiet prospect{overview.quietProspects === 1 ? "" : "s"} with no history
                </span>
              )}
            </div>
            {overview.goingCold.length === 0 ? (
              <p className="px-5 py-4 text-sm text-neutral-500">
                No client with won or open work has gone quiet.
                {overview.quietProspects > 0 && ` ${overview.quietProspects} prospect(s) with no history are also quiet.`}
              </p>
            ) : (
              <ul className="divide-y divide-neutral-200">
                {overview.goingCold.slice(0, 8).map((c) => (
                  <li key={c.companyId}>
                    <Link href={`/companies/${c.companyId}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-neutral-50">
                      <span className="min-w-0">
                        <span className="font-medium">{c.name}</span>
                        <span className="block text-xs text-neutral-500">
                          {money(c.lifetimeWonValue, { compact: true })} lifetime · {c.wonCount} job{c.wonCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      <AgingChip date={c.lastContactedAt} emptyLabel="No contact" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-neutral-200 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Quiet open deals ({overview.staleOpenDeals.length})
            </div>
            {overview.staleOpenDeals.length === 0 ? (
              <p className="px-5 py-4 text-sm text-neutral-500">Every open deal has had recent activity.</p>
            ) : (
              <ul className="divide-y divide-neutral-200">
                {overview.staleOpenDeals.map((d) => (
                  <li key={d.salesmateId} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{d.title}</span>
                      <span className="block text-xs text-neutral-500">
                        {d.companyId ? (
                          <Link href={`/companies/${d.companyId}`} className="hover:underline">
                            {d.companyName}
                          </Link>
                        ) : (
                          "No linked client"
                        )}
                        {d.stage ? ` · ${d.stage}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm">
                      <span className="block font-medium">{money(d.value, { compact: true })}</span>
                      <span className="text-xs text-neutral-500">
                        {d.daysQuiet < 0 ? "no activity logged" : `quiet ${d.daysQuiet} days`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold">Clients by value</h2>
        <p className="mb-3 text-sm text-neutral-500">
          Won and open value come from Salesmate; proposals come from ForgeOS as they&apos;re sent.
        </p>
        {overview.clients.length === 0 ? (
          <EmptyState message="No clients yet on this book." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Client</th>
                  <th className="px-4 py-2 text-right">Lifetime won</th>
                  <th className="px-4 py-2 text-right">Won 12mo</th>
                  <th className="px-4 py-2 text-right">Open</th>
                  <th className="px-4 py-2 text-right">Proposals</th>
                  <th className="px-4 py-2">Last contacted</th>
                  <th className="px-4 py-2">Last worked with</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {overview.clients.slice(0, 50).map((c) => (
                  <tr key={c.companyId} className="hover:bg-neutral-50">
                    <td className="px-4 py-2">
                      <Link href={`/companies/${c.companyId}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      {c.salesmateType && c.salesmateType !== "Customer" && (
                        <StatusChip tone="neutral">{c.salesmateType}</StatusChip>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(c.lifetimeWonValue)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.wonValue12mo ? money(c.wonValue12mo) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.openValue ? money(c.openValue) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {c.proposalsSent ? `${c.proposalsSigned}/${c.proposalsSent}` : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <AgingChip date={c.lastContactedAt} emptyLabel="Never" />
                    </td>
                    <td className="px-4 py-2 text-neutral-600">{ageLabel(c.lastWorkedWithAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overview.clients.length > 50 && (
              <p className="px-4 py-3 text-xs text-neutral-500">Showing the top 50 of {overview.clients.length} clients by lifetime value.</p>
            )}
          </Card>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold">Open pipeline by stage</h2>
        <p className="mb-3 text-sm text-neutral-500">
          Salesmate stages. In ForgeOS right now: {overview.forgeos.openEstimates} estimate
          {overview.forgeos.openEstimates === 1 ? "" : "s"} in progress, {overview.forgeos.proposalsSent} proposal
          {overview.forgeos.proposalsSent === 1 ? "" : "s"} sent, {overview.forgeos.proposalsSigned} signed.
        </p>
        {overview.pipelineByStage.length === 0 ? (
          <EmptyState message="No open deals." />
        ) : (
          <Card>
            <ul className="divide-y divide-neutral-200">
              {overview.pipelineByStage.map((s) => (
                <li key={s.stage} className="flex items-center justify-between px-5 py-3 text-sm">
                  <span className="font-medium">{s.stage}</span>
                  <span className="text-neutral-600">
                    {s.count} deal{s.count === 1 ? "" : "s"} · <span className="tabular-nums">{money(s.value)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {canSeeTeam && leaderboard.length > 0 && (
        <section>
          <h2 className="mb-1 text-lg font-semibold">Team</h2>
          <p className="mb-3 text-sm text-neutral-500">
            Last 12 months. &ldquo;Former reps&rdquo; holds deals whose Salesmate owner is no longer active -- those clients
            need an owner.
          </p>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Rep</th>
                  <th className="px-4 py-2 text-right">Won 12mo</th>
                  <th className="px-4 py-2 text-right">Jobs</th>
                  <th className="px-4 py-2 text-right">Open</th>
                  <th className="px-4 py-2 text-right">Win rate</th>
                  <th className="px-4 py-2 text-right">Clients</th>
                  <th className="px-4 py-2 text-right">Going cold</th>
                  <th className="px-4 py-2 text-right">Median since contact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {leaderboard.map((r) => (
                  <tr key={r.userId ?? "former"} className="hover:bg-neutral-50">
                    <td className="px-4 py-2 font-medium">
                      {r.userId ? (
                        <Link href={`/sales?rep=${r.userId}`} className="hover:underline">
                          {r.name}
                        </Link>
                      ) : (
                        <span className="text-neutral-500">{r.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.wonValue12mo)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.wonCount12mo}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.openValue ? money(r.openValue) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{percent(r.winRateCount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.clients}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.coldClients}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r.medianDaysSinceContact == null ? "—" : `${r.medianDaysSinceContact}d`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
    </div>
  );
}
