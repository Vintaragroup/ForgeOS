import Link from "next/link";
import { db } from "@/lib/db";
import { isSalesmateConfigured } from "@/lib/salesmate-client";
import { suggestCompanyMatches, type SalesmateSyncStats } from "@/lib/salesmate-sync";
import { ageLabel } from "@/lib/contact-aging";
import { Button, Card, CollapsibleSection, EmptyState, PageHeader, Stat, StatusBanner, StatusChip } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { LocalTimestamp } from "@/components/local-timestamp";
import {
  createCompanyAction,
  ignoreCompanyAction,
  linkCompanyAction,
  syncNowAction,
  unlinkCompanyAction,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE = { SUCCEEDED: "good", FAILED: "critical", RUNNING: "info" } as const;

// Customers first -- they're who the company-level aging and deal history
// matter most for -- then prospects/leads, then everything else.
const TYPE_ORDER = ["Customer", "Prospect", "Lead", "Marketing Qualified Lead", "Partner"];

export default async function SalesmateIntegrationPage() {
  const configured = isSalesmateConfigured();
  const [runs, lastSuccess, mirrorCounts, contactsSynced, dealsTotal, dealsLinked, waiting, linked, unlinkedCompanies, dealCounts] =
    await Promise.all([
      db.salesmateSyncRun.findMany({ orderBy: { startedAt: "desc" }, take: 10, include: { triggeredBy: { select: { name: true } } } }),
      db.salesmateSyncRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } }),
      db.salesmateCompany.groupBy({
        by: ["companyId"],
        where: { removedAt: null },
        _count: true,
      }),
      db.contact.count({ where: { salesmateId: { not: null }, deletedAt: null } }),
      db.salesmateDeal.count({ where: { removedAt: null } }),
      db.salesmateDeal.count({ where: { removedAt: null, companyId: { not: null } } }),
      db.salesmateCompany.findMany({ where: { companyId: null, ignoredAt: null, removedAt: null } }),
      db.salesmateCompany.findMany({
        where: { companyId: { not: null }, removedAt: null },
        include: { company: { select: { id: true, name: true } } },
        orderBy: { name: "asc" },
      }),
      db.company.findMany({ where: { deletedAt: null, salesmateCompany: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      db.salesmateDeal.groupBy({ by: ["salesmateCompanyId"], where: { removedAt: null }, _count: true }),
    ]);

  const mirroredTotal = mirrorCounts.reduce((sum, g) => sum + g._count, 0);
  const ignoredCount = await db.salesmateCompany.count({ where: { ignoredAt: { not: null }, companyId: null, removedAt: null } });
  const dealsBySalesmateCompany = new Map(dealCounts.map((d) => [d.salesmateCompanyId, d._count]));
  const lastRun = runs[0];
  const typeRank = (t: string | null) => {
    const i = TYPE_ORDER.indexOf(t ?? "");
    return i === -1 ? TYPE_ORDER.length : i;
  };
  const queue = [...waiting].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.name.localeCompare(b.name));

  return (
    <div>
      <PageHeader title="Salesmate" backHref="/admin/users" backLabel="Admin" />

      <Card className="mb-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Connection</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {!configured ? (
                <StatusChip tone="critical">Not configured on this server</StatusChip>
              ) : lastRun?.status === "FAILED" ? (
                <StatusChip tone="critical">Last sync failed</StatusChip>
              ) : lastSuccess ? (
                <StatusChip tone="good">Connected</StatusChip>
              ) : (
                <StatusChip tone="warning">Never synced</StatusChip>
              )}
              {lastSuccess && (
                <span className="text-neutral-600">
                  Last successful sync {ageLabel(lastSuccess.startedAt).toLowerCase()} (
                  <LocalTimestamp iso={lastSuccess.startedAt} />)
                </span>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm text-neutral-500">
              One-way: Salesmate → ForgeOS. Syncs companies, contacts, and deals every morning at 6am Eastern, and
              whenever you press Sync now. ForgeOS never changes anything in Salesmate.
            </p>
          </div>
          <form action={syncNowAction}>
            <SubmitButton pendingText="Syncing…" variant="primary">
              Sync now
            </SubmitButton>
          </form>
        </div>
        {!configured && (
          <div className="mt-4">
            <StatusBanner kind="error">
              SALESMATE_DOMAIN and SALESMATE_ACCESS_TOKEN aren&apos;t set in this server&apos;s environment, so it
              can&apos;t reach Salesmate. Add them in Vercel → Project → Settings → Environment Variables, then redeploy.
            </StatusBanner>
          </div>
        )}
        {lastRun?.status === "FAILED" && lastRun.error && (
          <div className="mt-4">
            <StatusBanner kind="error">{lastRun.error}</StatusBanner>
          </div>
        )}
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Card className="p-4">
          <Stat value={`${linked.length} / ${mirroredTotal}`} label="Salesmate companies linked" />
        </Card>
        <Card className="p-4">
          <Stat value={String(queue.length)} label="Waiting for review" />
        </Card>
        <Card className="p-4">
          <Stat value={String(contactsSynced)} label="Contacts synced" />
        </Card>
        <Card className="p-4">
          <Stat value={`${dealsLinked} / ${dealsTotal}`} label="Deals on linked companies" />
        </Card>
      </div>

      <CollapsibleSection title={`Companies to review (${queue.length})`} defaultOpen={queue.length > 0}>
        <p className="mb-4 text-sm text-neutral-500">
          These Salesmate companies didn&apos;t match a ForgeOS company by exact name. Link each one to the ForgeOS
          company it really is (suggestions first), create it as a new company, or ignore it. Its deal history attaches
          right away; its contacts arrive on the next sync.
          {ignoredCount > 0 && ` ${ignoredCount} ignored.`}
        </p>
        {queue.length === 0 ? (
          <EmptyState message="Nothing to review -- every Salesmate company is linked or ignored." />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-neutral-200">
              {queue.map((mirror) => {
                const suggestions = suggestCompanyMatches(mirror.name, unlinkedCompanies);
                const suggestedIds = new Set(suggestions.map((s) => s.id));
                const deals = dealsBySalesmateCompany.get(mirror.salesmateId) ?? 0;
                return (
                  <li key={mirror.salesmateId} className="flex flex-col gap-3 px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{mirror.name}</span>
                      {mirror.type && <StatusChip tone={mirror.type === "Customer" ? "info" : "neutral"}>{mirror.type}</StatusChip>}
                      <span className="text-xs text-neutral-500">
                        {deals} deal{deals === 1 ? "" : "s"}
                        {mirror.ownerName ? ` · owner ${mirror.ownerName}` : ""}
                        {mirror.lastCommunicationAt ? ` · last contacted ${ageLabel(mirror.lastCommunicationAt).toLowerCase()}` : ""}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <ActionForm action={linkCompanyAction.bind(null, mirror.salesmateId)} className="flex flex-wrap items-end gap-2">
                        <select
                          name="companyId"
                          defaultValue={suggestions[0]?.id ?? ""}
                          className="min-w-72 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
                        >
                          <option value="">Link to a ForgeOS company…</option>
                          {suggestions.length > 0 && (
                            <optgroup label="Suggested">
                              {suggestions.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="All unlinked companies">
                            {unlinkedCompanies
                              .filter((c) => !suggestedIds.has(c.id))
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </optgroup>
                        </select>
                        <Button variant="secondary">Link</Button>
                      </ActionForm>
                      <ActionForm action={createCompanyAction.bind(null, mirror.salesmateId)}>
                        <Button variant="secondary">Create as new company</Button>
                      </ActionForm>
                      <form action={ignoreCompanyAction.bind(null, mirror.salesmateId)}>
                        <button type="submit" className="py-2 text-sm text-neutral-500 hover:text-neutral-900">
                          Ignore
                        </button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </CollapsibleSection>

      <div className="mt-6">
        <CollapsibleSection title={`Recent syncs (${runs.length})`} defaultOpen>
          {runs.length === 0 ? (
            <EmptyState message="No syncs yet." />
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-2">Started</th>
                    <th className="px-4 py-2">How</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Companies</th>
                    <th className="px-4 py-2">Contacts</th>
                    <th className="px-4 py-2">Deals</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200">
                  {runs.map((run) => {
                    const stats = run.stats as unknown as SalesmateSyncStats | null;
                    const seconds = run.finishedAt ? Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000) : null;
                    return (
                      <tr key={run.id} className="align-top">
                        <td className="px-4 py-2 whitespace-nowrap">
                          <LocalTimestamp iso={run.startedAt} />
                          {seconds != null && <div className="text-xs text-neutral-400">{seconds}s</div>}
                        </td>
                        <td className="px-4 py-2">
                          {run.trigger === "CRON" ? "Daily" : run.trigger === "MANUAL" ? `Sync now${run.triggeredBy ? ` (${run.triggeredBy.name})` : ""}` : "Script"}
                        </td>
                        <td className="px-4 py-2">
                          <StatusChip tone={STATUS_TONE[run.status]}>{run.status.toLowerCase()}</StatusChip>
                          {run.error && <div className="mt-1 max-w-xs text-xs text-red-700">{run.error}</div>}
                        </td>
                        <td className="px-4 py-2 text-neutral-600">
                          {stats ? `${stats.companies.fetched} fetched · ${stats.companies.created} new · ${stats.companies.autoLinked} auto-linked` : "—"}
                        </td>
                        <td className="px-4 py-2 text-neutral-600">
                          {stats
                            ? `${stats.contacts.created} new · ${stats.contacts.updated + stats.contacts.adopted} updated · ${stats.contacts.waitingOnCompany} waiting`
                            : "—"}
                        </td>
                        <td className="px-4 py-2 text-neutral-600">
                          {stats ? `${stats.deals.fetched} fetched · ${stats.deals.created} new · ${stats.deals.removed} removed` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </CollapsibleSection>
      </div>

      <div className="mt-6">
        <CollapsibleSection title={`Linked companies (${linked.length})`} defaultOpen={false}>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-neutral-200">
              {linked.map((mirror) => (
                <li key={mirror.salesmateId} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                  <div>
                    <span className="text-neutral-500">{mirror.name}</span>
                    <span className="mx-2 text-neutral-300">→</span>
                    <Link href={`/companies/${mirror.company!.id}`} className="font-medium hover:underline">
                      {mirror.company!.name}
                    </Link>
                  </div>
                  <form action={unlinkCompanyAction.bind(null, mirror.salesmateId)}>
                    <button type="submit" className="text-xs text-neutral-500 hover:text-red-700">
                      Unlink
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        </CollapsibleSection>
      </div>
    </div>
  );
}
