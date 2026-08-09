import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const RESULT_LIMIT = 15;

// B14: one text box, three entity types (companies, opportunities,
// estimates), matched by name/show name -- exactly the scope the backlog
// names. Estimate has no name of its own, so it's matched through its
// opportunity's show name and company name instead.
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  const [companies, opportunities, estimates] = term
    ? await Promise.all([
        db.company.findMany({
          where: { deletedAt: null, name: { contains: term, mode: "insensitive" } },
          orderBy: { name: "asc" },
          take: RESULT_LIMIT,
        }),
        db.opportunity.findMany({
          where: { deletedAt: null, showName: { contains: term, mode: "insensitive" } },
          orderBy: { updatedAt: "desc" },
          take: RESULT_LIMIT,
          include: { company: { select: { name: true } } },
        }),
        db.estimate.findMany({
          where: {
            deletedAt: null,
            opportunity: {
              OR: [
                { showName: { contains: term, mode: "insensitive" } },
                { company: { name: { contains: term, mode: "insensitive" } } },
              ],
            },
          },
          orderBy: { updatedAt: "desc" },
          take: RESULT_LIMIT,
          include: { opportunity: { select: { showName: true, company: { select: { name: true } } } } },
        }),
      ])
    : [[], [], []];

  const totalResults = companies.length + opportunities.length + estimates.length;

  return (
    <div>
      <PageHeader title="Search" />

      <form action="/search" method="GET" className="mb-6">
        <input
          type="search"
          name="q"
          defaultValue={term}
          autoFocus
          placeholder="Search companies, opportunities, estimates…"
          className="w-full rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm shadow-sm focus:border-brand-teal focus:outline-none focus:ring-1 focus:ring-brand-teal"
        />
      </form>

      {!term ? (
        <EmptyState message="Enter a search term to find companies, opportunities, or estimates." />
      ) : totalResults === 0 ? (
        <EmptyState message={`No results for "${term}".`} />
      ) : (
        <div className="flex flex-col gap-6">
          {companies.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
                Companies
              </h2>
              <Card>
                <ul className="divide-y divide-neutral-200">
                  {companies.map((company) => (
                    <li key={company.id}>
                      <Link
                        href={`/companies/${company.id}`}
                        className="block px-5 py-3 text-sm font-medium hover:bg-neutral-50"
                      >
                        {company.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {opportunities.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
                Opportunities
              </h2>
              <Card>
                <ul className="divide-y divide-neutral-200">
                  {opportunities.map((opp) => (
                    <li key={opp.id}>
                      <Link
                        href={`/opportunities/${opp.id}`}
                        className="flex items-center justify-between px-5 py-3 text-sm hover:bg-neutral-50"
                      >
                        <span className="font-medium">{opp.showName}</span>
                        <span className="text-neutral-500">{opp.company.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {estimates.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
                Estimates
              </h2>
              <Card>
                <ul className="divide-y divide-neutral-200">
                  {estimates.map((estimate) => (
                    <li key={estimate.id}>
                      <Link
                        href={`/estimates/${estimate.id}`}
                        className="flex items-center justify-between px-5 py-3 text-sm hover:bg-neutral-50"
                      >
                        <span className="font-medium">{estimate.opportunity.showName}</span>
                        <span className="text-neutral-500">{estimate.opportunity.company.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
