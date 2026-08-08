import Link from "next/link";
import { db } from "@/lib/db";
import { LinkButton, PageHeader } from "@/components/ui";

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

export default async function OpportunitiesPage() {
  const opportunities = await db.opportunity.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: "desc" },
    include: { company: true },
  });

  const byStage = Object.fromEntries(STAGES.map((s) => [s.value, [] as typeof opportunities]));
  for (const opp of opportunities) {
    byStage[opp.stage]?.push(opp);
  }

  return (
    <div>
      <PageHeader
        title="Opportunities"
        action={<LinkButton href="/opportunities/new">New opportunity</LinkButton>}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {STAGES.map((stage) => (
          <div key={stage.value} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold text-neutral-700">{stage.label}</h2>
              <span className="text-xs text-neutral-400">{byStage[stage.value].length}</span>
            </div>
            <div className="flex min-h-[4rem] flex-col gap-2 rounded-lg bg-neutral-100 p-2">
              {byStage[stage.value].map((opp) => (
                <Link
                  key={opp.id}
                  href={`/opportunities/${opp.id}`}
                  className="rounded-md border border-neutral-200 bg-white p-3 text-sm shadow-sm hover:border-neutral-400"
                >
                  <div className="font-medium">{opp.showName}</div>
                  <div className="text-neutral-500">{opp.company.name}</div>
                  {opp.boothNumber && (
                    <div className="mt-1 text-xs text-neutral-400">Booth {opp.boothNumber}</div>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
