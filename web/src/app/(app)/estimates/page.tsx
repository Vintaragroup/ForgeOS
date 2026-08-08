import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, PageHeader, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

function EstimateStatusChip({ status }: { status: string }) {
  if (status === "IN_PROGRESS") return <StatusChip tone="info">In progress</StatusChip>;
  return <StatusChip tone="neutral">Draft</StatusChip>;
}

export default async function EstimatesPage() {
  const estimates = await db.estimate.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      opportunity: { include: { company: true } },
      versions: { where: { isCurrent: true } },
    },
  });

  return (
    <div>
      <PageHeader title="Estimates" />
      {estimates.length === 0 ? (
        <EmptyState message="No estimates yet. Convert an opportunity to start one." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {estimates.map((estimate) => {
              const version = estimate.versions[0];
              return (
                <li key={estimate.id}>
                  <Link
                    href={`/estimates/${estimate.id}`}
                    className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                  >
                    <div>
                      <div className="font-medium">{estimate.opportunity.showName}</div>
                      <div className="text-sm text-neutral-500">
                        {estimate.opportunity.company.name}
                        {estimate.taxCity ? ` · ${estimate.taxCity}` : ""}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 text-sm text-neutral-500">
                      <div>
                        {version
                          ? `$${version.grandTotal.toString()}${version.isLocked ? " · locked" : ""}${version.isApproved ? " · approved" : ""}`
                          : "No version started"}
                      </div>
                      <EstimateStatusChip status={estimate.status} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
