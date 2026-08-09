import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { computeChangeOrderDiff } from "@/lib/change-order-service";
import { approveChangeOrderAction, rejectChangeOrderAction } from "../actions";
import { Button, Card, PageHeader } from "@/components/ui";

function money(d: { toFixed(n: number): string }): string {
  return `$${d.toFixed(2)}`;
}

export default async function ChangeOrderDetailPage(props: PageProps<"/change-orders/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const changeOrder = await db.changeOrder.findFirst({
    where: { id },
    include: {
      estimate: { include: { opportunity: { include: { company: true } } } },
      baseVersion: { include: { sections: { where: { optionId: null }, include: { lineItems: true } } } },
      resultVersion: { include: { sections: { where: { optionId: null }, include: { lineItems: true } } } },
    },
  });
  if (!changeOrder) notFound();
  if (!(await canAccessOpportunity(user, changeOrder.estimate.opportunityId))) notFound();

  const diff = computeChangeOrderDiff(changeOrder.baseVersion.sections, changeOrder.resultVersion.sections);
  const netDelta = diff.reduce((sum, row) => sum.plus(row.delta), new Prisma.Decimal(0));

  const approveWithIds = approveChangeOrderAction.bind(null, changeOrder.id, changeOrder.estimateId);
  const rejectWithIds = rejectChangeOrderAction.bind(null, changeOrder.id, changeOrder.estimateId);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Change order — ${changeOrder.estimate.opportunity.showName}`}
        action={
          <Link href={`/estimates/${changeOrder.estimateId}`} className="text-sm text-neutral-500 hover:text-neutral-900">
            ← Back to estimate
          </Link>
        }
      />

      <Card className="p-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Description</h2>
        <p className="mb-4 text-sm">{changeOrder.description}</p>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-neutral-500">Status</dt>
            <dd className="font-medium">{changeOrder.status}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Base version</dt>
            <dd className="font-medium">
              Version {changeOrder.baseVersion.versionNumber} ({money(changeOrder.baseVersion.totalCost)})
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">Result version</dt>
            <dd className="font-medium">
              Version {changeOrder.resultVersion.versionNumber}{" "}
              {changeOrder.resultVersion.isLocked ? "· locked" : "· still editing"} (
              {money(changeOrder.resultVersion.totalCost)})
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Changes vs. base version
        </h2>
        {diff.length === 0 ? (
          <p className="text-sm text-neutral-500">No changes yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="pb-1 font-normal">Section</th>
                <th className="pb-1 font-normal">Description</th>
                <th className="pb-1 font-normal">Change</th>
                <th className="pb-1 text-right font-normal">Base</th>
                <th className="pb-1 text-right font-normal">Result</th>
                <th className="pb-1 text-right font-normal">Delta</th>
              </tr>
            </thead>
            <tbody>
              {diff.map((row) => (
                <tr key={`${row.section}::${row.description}`} className="border-t border-neutral-100">
                  <td className="py-1.5 text-neutral-500">{row.section}</td>
                  <td className="py-1.5">{row.description}</td>
                  <td className="py-1.5">{row.kind}</td>
                  <td className="py-1.5 text-right">{row.baseTotalCost ? money(row.baseTotalCost) : "—"}</td>
                  <td className="py-1.5 text-right">{row.resultTotalCost ? money(row.resultTotalCost) : "—"}</td>
                  <td className="py-1.5 text-right">
                    {row.delta.isNegative() ? "-" : "+"}
                    {money(row.delta.abs())}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-neutral-300 font-medium">
                <td className="py-1.5" colSpan={5}>
                  Net cost change
                </td>
                <td className="py-1.5 text-right">
                  {netDelta.isNegative() ? "-" : "+"}
                  {money(netDelta.abs())}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      {changeOrder.status === "DRAFT" && (
        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Decision</h2>
          {!changeOrder.resultVersion.isLocked ? (
            <p className="text-sm text-neutral-500">
              Finish editing and lock the result version on the{" "}
              <Link href={`/estimates/${changeOrder.estimateId}`} className="underline">
                estimate page
              </Link>{" "}
              before approving or rejecting this change order.
            </p>
          ) : (
            <div className="flex gap-3">
              <form action={approveWithIds}>
                <Button>Approve change order</Button>
              </form>
              <form action={rejectWithIds}>
                <Button variant="danger">Reject</Button>
              </form>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
