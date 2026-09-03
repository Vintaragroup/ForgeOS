import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { taxRateLabel } from "@/lib/tax-rate";
import { Card, EmptyState, PageHeader, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

function EstimateStatusChip({ status }: { status: string }) {
  if (status === "IN_PROGRESS") return <StatusChip tone="info">In progress</StatusChip>;
  return <StatusChip tone="neutral">Draft</StatusChip>;
}

export default async function EstimatesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const estimates = await db.estimate.findMany({
    // deletedAt: null on the Estimate itself isn't enough -- deleteOpportunity
    // only soft-deletes the Opportunity row, it never cascades to its
    // Estimates, so without this an estimate whose parent opportunity was
    // deleted kept showing up here indefinitely (confirmed live).
    where: { deletedAt: null, archivedAt: null, opportunity: { deletedAt: null, ...opportunityAccessWhere(user) } },
    orderBy: { createdAt: "desc" },
    include: {
      opportunity: { include: { company: true } },
      versions: { where: { isCurrent: true } },
      taxRate: true,
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
                        {estimate.taxRate ? ` · ${taxRateLabel(estimate.taxRate)}` : ""}
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
