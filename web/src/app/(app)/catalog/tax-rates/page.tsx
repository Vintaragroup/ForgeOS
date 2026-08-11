import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function TaxRatesPage() {
  const rates = await db.taxRate.findMany({
    where: { deletedAt: null },
    orderBy: [{ state: "asc" }, { city: "asc" }],
  });

  return (
    <div>
      <PageHeader
        title="Tax rates"
        backHref="/catalog"
        backLabel="Catalog"
        action={<LinkButton href="/catalog/tax-rates/new">New tax rate</LinkButton>}
      />
      <p className="mb-4 text-sm text-neutral-500">
        One combined sales tax rate per jurisdiction (state and local already rolled together) --
        selected per estimate to compute an estimated tax line on the proposal. No rates are
        pre-loaded; enter the real rate for each jurisdiction you bid in.
      </p>
      {rates.length === 0 ? (
        <EmptyState message="No tax rates yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {rates.map((rate) => (
              <li key={rate.id}>
                <Link
                  href={`/catalog/tax-rates/${rate.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">
                      {rate.label ?? (rate.city ? `${rate.city}, ${rate.state}` : rate.state)}
                    </div>
                    <div className="text-sm text-neutral-500">{rate.state}</div>
                  </div>
                  <div className="text-sm font-medium text-neutral-700">
                    {(rate.rate.toNumber() * 100).toFixed(2)}%
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
