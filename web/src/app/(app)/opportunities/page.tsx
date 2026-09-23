import Link from "next/link";
import { agedOffPipeline, pipelineClosedOn } from "@/lib/pipeline-window";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { LinkButton, PageHeader, StatusChip } from "@/components/ui";

// Reads live from the DB on every request -- without this, Next statically
// prerenders this route at build time and freezes a snapshot until the
// next deploy, which is wrong for a pipeline board that changes constantly.
export const dynamic = "force-dynamic";

const STAGES = [
  { value: "NEW", label: "New" },
  { value: "CONTACTED", label: "Contacted" },
  { value: "QUALIFIED", label: "Qualified" },
  { value: "ESTIMATING", label: "Estimating" },
  { value: "WON", label: "Won" },
  { value: "LOST", label: "Lost" },
] as const;

// Stages where a stale move-in date or a card sitting untouched no longer
// means anything -- the deal is already decided.
const TERMINAL_STAGES = new Set(["WON", "LOST"]);

const STALE_DAYS = 14;
const MOVE_IN_WARNING_DAYS = 30;

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function fmtUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function daysBetween(a: Date, b: Date) {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; closed?: string }>;
}) {
  const { stage: highlightStage, closed: closedParam } = await searchParams;
  const showAllClosed = closedParam === "all";
  const now = new Date();

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const opportunities = await db.opportunity.findMany({
    where: { deletedAt: null, ...opportunityAccessWhere(user) },
    orderBy: { updatedAt: "desc" },
    include: {
      company: true,
      owner: true,
      estimates: {
        where: { deletedAt: null, archivedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          versions: { where: { isCurrent: true }, take: 1 },
        },
      },
      stageEvents: { orderBy: { changedAt: "desc" }, take: 1 },
      // The show's date is what dates an imported deal. See closedOn below.
      show: { select: { eventStartDate: true } },
    },
  });

  const rows = opportunities.map((opp) => {
    const estimate = opp.estimates[0];
    const version = estimate?.versions[0];
    const value = version ? version.grandTotal.toNumber() : estimate?.budget ? estimate.budget.toNumber() : null;
    const lastStageChange = opp.stageEvents[0]?.changedAt ?? opp.createdAt;
    const daysInStage = daysBetween(now, lastStageChange);
    const daysToMoveIn = opp.targetMoveIn ? daysBetween(opp.targetMoveIn, now) : null;
    // See pipeline-window.ts for why this is not simply lastStageChange.
    const closedOn = pipelineClosedOn({
      eventStartDate: opp.eventStartDate,
      show: opp.show,
      lastStageChange,
    });
    return { opp, value, daysInStage, daysToMoveIn, closedOn };
  });

  const byStage = Object.fromEntries(STAGES.map((s) => [s.value, [] as typeof rows]));
  // Counted rather than silently dropped -- a column that just gets
  // shorter looks like data loss.
  let hiddenClosed = 0;
  for (const row of rows) {
    if (!showAllClosed && agedOffPipeline(row.opp.stage, row.closedOn, now)) {
      hiddenClosed += 1;
      continue;
    }
    byStage[row.opp.stage]?.push(row);
  }

  return (
    <div>
      <PageHeader
        title="Opportunities"
        action={<LinkButton href="/opportunities/new">New opportunity</LinkButton>}
      />
      {(hiddenClosed > 0 || showAllClosed) && (
        <p className="mb-4 text-xs text-neutral-500">
          {showAllClosed ? (
            <>
              Showing every closed deal, however old.{" "}
              <Link href="/opportunities" className="font-medium text-neutral-700 hover:underline">
                Back to the last 6 months →
              </Link>
            </>
          ) : (
            <>
              Won and Lost show the last 6 months. {hiddenClosed} older closed deal
              {hiddenClosed === 1 ? " is" : "s are"} hidden — they stay on their client and in reports.{" "}
              <Link href="/opportunities?closed=all" className="font-medium text-neutral-700 hover:underline">
                Show all →
              </Link>
            </>
          )}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {STAGES.map((stage) => {
          const stageRows = byStage[stage.value];
          const stageValue = stageRows.reduce((sum, r) => sum + (r.value ?? 0), 0);
          return (
            <div key={stage.value} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between px-1">
                <h2 className="text-sm font-semibold text-neutral-700">{stage.label}</h2>
                <span className="text-xs text-neutral-400">{stageRows.length}</span>
              </div>
              {stageValue > 0 && (
                <div className="px-1 text-xs font-medium text-brand-navy">{fmtUsd(stageValue)}</div>
              )}
              <div
                className={`flex min-h-[4rem] max-h-[36rem] flex-col gap-2 overflow-y-auto rounded-lg bg-neutral-100 p-2 ${
                  highlightStage === stage.value ? "ring-2 ring-brand-teal ring-offset-2" : ""
                }`}
              >
                {stageRows.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center py-4 text-xs text-neutral-400">
                    No opportunities
                  </div>
                ) : (
                  stageRows.map(({ opp, value, daysInStage, daysToMoveIn }) => {
                    const isTerminal = TERMINAL_STAGES.has(opp.stage);
                    const isStale = !isTerminal && daysInStage >= STALE_DAYS;
                    const showMoveIn =
                      !isTerminal && daysToMoveIn !== null && daysToMoveIn <= MOVE_IN_WARNING_DAYS;

                    return (
                      <Link
                        key={opp.id}
                        href={`/opportunities/${opp.id}`}
                        className="flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-white p-3 text-sm shadow-sm hover:border-neutral-400"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium">{opp.showName}</div>
                          {opp.owner && (
                            <span
                              title={opp.owner.name}
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-semibold text-neutral-600"
                            >
                              {initials(opp.owner.name)}
                            </span>
                          )}
                        </div>
                        <div className="text-neutral-500">{opp.company.name}</div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neutral-400">
                            {opp.boothNumber ? `Booth ${opp.boothNumber}` : ""}
                          </span>
                          {value !== null && (
                            <span className="font-medium text-brand-navy">{fmtUsd(value)}</span>
                          )}
                        </div>
                        {(showMoveIn || isStale) && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            {showMoveIn && (
                              <StatusChip tone={daysToMoveIn! < 0 ? "critical" : daysToMoveIn! <= 7 ? "warning" : "neutral"}>
                                {daysToMoveIn! < 0
                                  ? `Move-in ${Math.abs(daysToMoveIn!)}d overdue`
                                  : daysToMoveIn === 0
                                    ? "Move-in today"
                                    : `Move-in in ${daysToMoveIn}d`}
                              </StatusChip>
                            )}
                            {isStale && <StatusChip tone="warning">{daysInStage}d in stage</StatusChip>}
                          </div>
                        )}
                      </Link>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
