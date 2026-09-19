import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader, StatusChip } from "@/components/ui";
import { AgingChip } from "@/components/aging-chip";
import { EMPTY_AGING, loadCompanyAging } from "@/lib/company-aging";
import { isStale, STALE_FILTER_DAYS } from "@/lib/contact-aging";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

const SORTS = {
  name: "Name",
  contacted: "Longest since contacted",
  worked: "Longest since worked with",
} as const;
type SortKey = keyof typeof SORTS;

export default async function CompaniesPage(props: PageProps<"/companies">) {
  const params = await props.searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const sort: SortKey = one(params.sort) in SORTS ? (one(params.sort) as SortKey) : "name";
  const staleDays = STALE_FILTER_DAYS.find((d) => String(d) === one(params.stale));
  const typeFilter = one(params.type);

  const [companies, agingById] = await Promise.all([
    db.company.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      include: { _count: { select: { contacts: { where: { deletedAt: null } }, opportunities: { where: { deletedAt: null } } } } },
    }),
    // One pass over every company's contacts/deals/jobs -- cheaper than a
    // per-row query, and the list is a few hundred companies at most.
    loadCompanyAging(),
  ]);

  const rows = companies
    .map((company) => ({ company, aging: agingById.get(company.id) ?? EMPTY_AGING }))
    .filter(({ aging }) => !typeFilter || (typeFilter === "none" ? !aging.salesmateType : aging.salesmateType === typeFilter))
    .filter(({ aging }) => !staleDays || isStale(aging.lastContacted?.at, staleDays));

  // Oldest first, never-contacted at the very top -- "who needs a call".
  const time = (d: Date | undefined) => d?.getTime() ?? -Infinity;
  if (sort === "contacted") rows.sort((a, b) => time(a.aging.lastContacted?.at) - time(b.aging.lastContacted?.at));
  if (sort === "worked") rows.sort((a, b) => time(a.aging.lastWorkedWith?.at) - time(b.aging.lastWorkedWith?.at));

  const types = [...new Set([...agingById.values()].map((a) => a.salesmateType).filter((t): t is string => Boolean(t)))].sort();
  const isFiltered = Boolean(staleDays || typeFilter);
  const selectClass = "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm";

  return (
    <div>
      <PageHeader title="Companies" action={<LinkButton href="/companies/new">New company</LinkButton>} />

      <Card className="mb-4 p-4">
        <form className="flex flex-wrap items-end gap-3" action="/companies">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Salesmate type</span>
            <select name="type" defaultValue={typeFilter} className={selectClass}>
              <option value="">All</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              <option value="none">Not in Salesmate</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Last contacted</span>
            <select name="stale" defaultValue={staleDays ? String(staleDays) : ""} className={selectClass}>
              <option value="">Any time</option>
              {STALE_FILTER_DAYS.map((d) => (
                <option key={d} value={d}>
                  Not in {d}+ days
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Sort</span>
            <select name="sort" defaultValue={sort} className={selectClass}>
              {Object.entries(SORTS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md bg-brand-black px-4 py-2 text-sm font-medium text-white hover:bg-brand-navy"
          >
            Apply
          </button>
          {(isFiltered || sort !== "name") && (
            <Link href="/companies" className="py-2 text-sm text-neutral-500 hover:text-neutral-900">
              Clear
            </Link>
          )}
        </form>
      </Card>

      <p className="mb-3 text-sm text-neutral-500">
        {isFiltered ? `${rows.length} of ${companies.length} companies.` : `${companies.length} companies.`} Last contacted
        comes from Salesmate; last worked with is the most recent won job&apos;s show.
      </p>

      {rows.length === 0 ? (
        <EmptyState
          message={isFiltered ? "No companies match those filters." : "No companies yet. Add the first client/exhibitor company to get started."}
        />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {rows.map(({ company, aging }) => (
              <li key={company.id}>
                <Link
                  href={`/companies/${company.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-neutral-50"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{company.name}</span>
                      {aging.salesmateType && (
                        <StatusChip tone={aging.salesmateType === "Customer" ? "info" : "neutral"}>{aging.salesmateType}</StatusChip>
                      )}
                    </div>
                    <div className="text-sm text-neutral-500">
                      {company._count.contacts} contact{company._count.contacts === 1 ? "" : "s"} ·{" "}
                      {company._count.opportunities} opportunit{company._count.opportunities === 1 ? "y" : "ies"}
                      {company.industry ? ` · ${company.industry}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-500">
                    <span className="flex items-center gap-1.5">
                      Contacted <AgingChip date={aging.lastContacted?.at} />
                    </span>
                    <span className="flex items-center gap-1.5">
                      Worked with{" "}
                      <AgingChip
                        date={aging.lastWorkedWith?.at}
                        emptyLabel={aging.wonWithoutShowDate > 0 ? "No show dates" : "Never"}
                      />
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
