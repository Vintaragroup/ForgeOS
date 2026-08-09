import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const RESULT_LIMIT = 15;
const SNIPPET_RADIUS = 70;

// A short excerpt around the first match, so a document that matched on
// body text (not filename) shows *why* -- otherwise a hit inside a
// 50-page contract is just a filename with no context.
function buildSnippet(text: string, term: string): string | null {
  const index = text.toLowerCase().indexOf(term.toLowerCase());
  if (index === -1) return null;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + term.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

// B14: one text box, four entity types (companies, opportunities,
// estimates, documents) matched by name/show name/file content.
// Estimate has no name of its own, so it's matched through its
// opportunity's show name and company name instead.
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  const [companies, opportunities, estimates, documents] = term
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
        // Filename OR the extracted body text -- "liquidated damages" finds
        // it inside a contract nobody would have thought to name that.
        db.document.findMany({
          where: {
            deletedAt: null,
            OR: [
              { filename: { contains: term, mode: "insensitive" } },
              { extractedText: { contains: term, mode: "insensitive" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take: RESULT_LIMIT,
          include: { opportunity: { select: { id: true, showName: true } } },
        }),
      ])
    : [[], [], [], []];

  const totalResults = companies.length + opportunities.length + estimates.length + documents.length;

  return (
    <div>
      <PageHeader title="Search" />

      <form action="/search" method="GET" className="mb-6">
        <input
          type="search"
          name="q"
          defaultValue={term}
          autoFocus
          placeholder="Search companies, opportunities, estimates, documents…"
          className="w-full rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm shadow-sm focus:border-brand-teal focus:outline-none focus:ring-1 focus:ring-brand-teal"
        />
      </form>

      {!term ? (
        <EmptyState message="Enter a search term to find companies, opportunities, estimates, or documents." />
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

          {documents.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
                Documents
              </h2>
              <Card>
                <ul className="divide-y divide-neutral-200">
                  {documents.map((doc) => {
                    const snippet = doc.extractedText ? buildSnippet(doc.extractedText, term) : null;
                    return (
                      <li key={doc.id}>
                        <Link
                          href={`/opportunities/${doc.opportunity.id}/documents/${doc.id}/view`}
                          className="block px-5 py-3 text-sm hover:bg-neutral-50"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{doc.filename}</span>
                            <span className="text-neutral-500">{doc.opportunity.showName}</span>
                          </div>
                          {snippet && <p className="mt-1 text-neutral-500">{snippet}</p>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
