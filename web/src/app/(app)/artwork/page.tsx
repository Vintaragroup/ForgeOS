import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { PageHeader, StatusChip, EmptyState } from "@/components/ui";

// Same "always fresh" reasoning as the Opportunities pipeline board --
// this is a live queue, not something that should freeze at build time.
export const dynamic = "force-dynamic";

// Statuses where something needs a human's attention right now, per the
// spec's Review Queue wireframe (6.5) -- everything else is either waiting
// on the client/vendor or already done. Order here also sets display order.
const ACTIONABLE_STATUSES = ["UNDER_ART_REVIEW", "EXPO_PROOF_CHECK", "ESCALATED"] as const;

const STATUS_TONE: Record<string, "neutral" | "info" | "warning" | "good" | "critical"> = {
  UNDER_ART_REVIEW: "info",
  EXPO_PROOF_CHECK: "info",
  PROOF_REVISION_REQUESTED: "warning",
  ESCALATED: "critical",
  REJECTED: "warning",
  DELIVERED_AT_SHOW: "good",
};

export default async function ArtworkReviewQueuePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orders = await db.artworkOrder.findMany({
    where: { deletedAt: null, opportunity: opportunityAccessWhere(user) },
    orderBy: { updatedAt: "desc" },
    include: { opportunity: { include: { company: true } }, vendor: { select: { name: true } } },
  });

  const actionable = orders.filter((o) => (ACTIONABLE_STATUSES as readonly string[]).includes(o.status));
  const inFlight = orders.filter((o) => !(ACTIONABLE_STATUSES as readonly string[]).includes(o.status) && o.status !== "DELIVERED_AT_SHOW");
  const now = new Date();

  return (
    <>
      <PageHeader title="Artwork review queue" />
      <div className="flex flex-col gap-6">
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Needs attention ({actionable.length})
          </h2>
          {actionable.length === 0 ? (
            <EmptyState message="Nothing waiting on Expo right now." />
          ) : (
            <ul className="flex flex-col gap-2">
              {actionable.map((order) => {
                const overdue = order.status === "EXPO_PROOF_CHECK" && order.slaDueAt != null && order.slaDueAt < now;
                return (
                  <li key={order.id}>
                    <Link
                      href={`/artwork/${order.id}`}
                      className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-4 py-3 text-sm hover:border-neutral-400"
                    >
                      <span className="flex items-center gap-3">
                        <span className="font-medium">{order.opportunity.company.name}</span>
                        <span className="text-neutral-500">{order.opportunity.showName}</span>
                        <span className="font-mono text-xs text-neutral-400">{order.jobCode}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        {overdue && <StatusChip tone="critical">SLA overdue</StatusChip>}
                        <StatusChip tone={STATUS_TONE[order.status] ?? "neutral"}>
                          {order.status.replaceAll("_", " ")}
                        </StatusChip>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            In flight ({inFlight.length})
          </h2>
          {inFlight.length === 0 ? (
            <EmptyState message="No other artwork orders in progress." />
          ) : (
            <ul className="flex flex-col gap-2">
              {inFlight.map((order) => (
                <li key={order.id}>
                  <Link
                    href={`/artwork/${order.id}`}
                    className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-4 py-3 text-sm hover:border-neutral-400"
                  >
                    <span className="flex items-center gap-3">
                      <span className="font-medium">{order.opportunity.company.name}</span>
                      <span className="text-neutral-500">{order.opportunity.showName}</span>
                      <span className="font-mono text-xs text-neutral-400">{order.jobCode}</span>
                      {order.vendor && <span className="text-neutral-400">via {order.vendor.name}</span>}
                    </span>
                    <StatusChip tone={STATUS_TONE[order.status] ?? "neutral"}>{order.status.replaceAll("_", " ")}</StatusChip>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
