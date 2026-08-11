import { db } from "@/lib/db";
import { Card, CollapsibleSection, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { LABOR_TIER_LABELS, LABOR_UNION_LABELS } from "@/lib/labor-rate";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

const TIER_ORDER: Record<string, number> = { STRAIGHT_TIME: 0, OVERTIME: 1, DOUBLE_TIME: 2 };

export default async function LaborRatesPage() {
  const rates = await db.laborRate.findMany({
    where: { deletedAt: null },
    orderBy: [{ rateType: "asc" }, { departmentName: "asc" }, { city: "asc" }],
  });

  const departments = rates.filter((r) => r.rateType === "DEPARTMENT");
  const cityRates = rates.filter((r) => r.rateType === "CITY_MARKET");

  // 78 markets x up to 3 tiers each is too many rows to browse flat --
  // group by city so straight/OT/DT sit together, same principle as
  // Materials' category grouping (materials/page.tsx).
  const cityGroups = new Map<string, typeof cityRates>();
  for (const rate of cityRates) {
    const key = rate.city ?? "—";
    if (!cityGroups.has(key)) cityGroups.set(key, []);
    cityGroups.get(key)!.push(rate);
  }
  const sortedCityGroups = [...cityGroups.entries()]
    .map(([city, group]) => [city, [...group].sort((a, b) => (TIER_ORDER[a.laborTier ?? ""] ?? 9) - (TIER_ORDER[b.laborTier ?? ""] ?? 9))] as const)
    .sort(([a], [b]) => a.localeCompare(b));

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
        <div className="flex flex-col gap-4">
          <CollapsibleSection title={`Shop labor (${departments.length})`} defaultOpen>
            <Card className="overflow-hidden">
              <ul className="divide-y divide-neutral-200">
                {departments.map((rate) => (
                  <li key={rate.id}>
                    <Link
                      href={`/catalog/labor-rates/${rate.id}`}
                      className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                    >
                      <div className="font-medium">
                        {rate.departmentName} <span className="text-neutral-400">({rate.departmentCode})</span>
                      </div>
                      <div className="text-sm font-medium text-neutral-700">${rate.rate.toString()}/hr</div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </CollapsibleSection>

          <CollapsibleSection
            title={`Show / site labor (${sortedCityGroups.length} markets)`}
            defaultOpen={sortedCityGroups.length <= 10}
          >
            <Card className="overflow-hidden">
              <ul className="divide-y divide-neutral-200">
                {sortedCityGroups.map(([city, group]) => (
                  <li key={city} className="px-5 py-3">
                    <div className="mb-1 flex items-center gap-2 text-sm font-medium text-neutral-900">
                      {city}
                      {group[0].unionStatus && (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500">
                          {LABOR_UNION_LABELS[group[0].unionStatus]}
                        </span>
                      )}
                      {group[0].notes && (
                        <span className="text-xs font-normal text-neutral-400">{group[0].notes}</span>
                      )}
                    </div>
                    <ul className="flex flex-col gap-0.5 pl-3">
                      {group.map((rate) => (
                        <li key={rate.id}>
                          <Link
                            href={`/catalog/labor-rates/${rate.id}`}
                            className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-neutral-50"
                          >
                            <span className="text-neutral-600">{LABOR_TIER_LABELS[rate.laborTier ?? ""] ?? "—"}</span>
                            <span className="font-medium text-neutral-700">${rate.rate.toString()}/hr</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Card>
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
