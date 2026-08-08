import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function LaborRatesPage() {
  const rates = await db.laborRate.findMany({
    where: { deletedAt: null },
    orderBy: [{ rateType: "asc" }, { departmentCode: "asc" }, { city: "asc" }],
  });

  return (
    <div>
      <PageHeader
        title="Labor rates"
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
    </div>
  );
}
