import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, Pagination, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function LaborRatesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const where = { deletedAt: null };
  const [rates, total] = await Promise.all([
    db.laborRate.findMany({
      where,
      orderBy: [{ rateType: "asc" }, { departmentCode: "asc" }, { city: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.laborRate.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Labor rates"
        backHref="/catalog"
        backLabel="Catalog"
        action={<LinkButton href="/catalog/labor-rates/new">New labor rate</LinkButton>}
      />
      {rates.length === 0 ? (
        <EmptyState message="No labor rates yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {rates.map((rate) => (
              <li key={rate.id}>
                <Link
                  href={`/catalog/labor-rates/${rate.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">
                      {rate.rateType === "DEPARTMENT"
                        ? `${rate.departmentName} (${rate.departmentCode})`
                        : rate.city}
                    </div>
                    <div className="text-sm text-neutral-500">{rate.rateType}</div>
                  </div>
                  <div className="text-sm font-medium text-neutral-700">
                    ${rate.rate.toString()}/hr
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Pagination page={page} totalPages={totalPages} basePath="/catalog/labor-rates" />
    </div>
  );
}
