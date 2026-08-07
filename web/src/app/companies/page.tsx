import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

export default async function CompaniesPage() {
  const companies = await db.company.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    include: { _count: { select: { contacts: true, opportunities: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Companies"
        action={<LinkButton href="/companies/new">New company</LinkButton>}
      />
      {companies.length === 0 ? (
        <EmptyState message="No companies yet. Add the first client/exhibitor company to get started." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {companies.map((company) => (
              <li key={company.id}>
                <Link
                  href={`/companies/${company.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">{company.name}</div>
                    {company.industry && (
                      <div className="text-sm text-neutral-500">{company.industry}</div>
                    )}
                  </div>
                  <div className="text-sm text-neutral-500">
                    {company._count.contacts} contact{company._count.contacts === 1 ? "" : "s"} ·{" "}
                    {company._count.opportunities} opportunit
                    {company._count.opportunities === 1 ? "y" : "ies"}
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
