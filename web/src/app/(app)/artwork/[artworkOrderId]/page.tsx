import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { Card, PageHeader, StatusChip, Field, SelectField, TextareaField, Button, ReadOnlyField, EmptyState } from "@/components/ui";
import {
  assignVendorAction,
  confirmProofMatchAction,
  issueCustomQuoteAction,
  issueProductionGoAheadAction,
  markDeliveredAction,
  requestProofRevisionAction,
  resolveEscalationAction,
  reviewArtworkOrderAction,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "neutral" | "info" | "warning" | "good" | "critical"> = {
  UNDER_ART_REVIEW: "info",
  EXPO_PROOF_CHECK: "info",
  PROOF_REVISION_REQUESTED: "warning",
  ESCALATED: "critical",
  REJECTED: "warning",
  DELIVERED_AT_SHOW: "good",
};

export default async function ArtworkOrderPage({
  params,
}: {
  params: Promise<{ artworkOrderId: string }>;
}) {
  const { artworkOrderId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const order = await db.artworkOrder.findUnique({
    where: { id: artworkOrderId, deletedAt: null },
    include: {
      opportunity: { include: { company: true } },
      vendor: true,
      sizeTier: true,
      files: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) notFound();
  if (!(await canAccessOpportunity(user, order.opportunityId))) notFound();

  const vendors = await db.vendor.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } });
  const reviewWithId = reviewArtworkOrderAction.bind(null, order.id);
  const issueQuoteWithId = issueCustomQuoteAction.bind(null, order.id);
  const assignVendorWithId = assignVendorAction.bind(null, order.id);
  const confirmMatchWithId = confirmProofMatchAction.bind(null, order.id);
  const requestRevisionWithId = requestProofRevisionAction.bind(null, order.id);
  const resolveEscalationWithId = resolveEscalationAction.bind(null, order.id);
  const issueGoAheadWithId = issueProductionGoAheadAction.bind(null, order.id);
  const markDeliveredWithId = markDeliveredAction.bind(null, order.id);

  const clientArtworkFile = order.files.find((f) => f.kind === "CLIENT_ARTWORK");
  const latestProof = [...order.files].reverse().find((f) => f.kind === "PROOF");
  const overdue = order.status === "EXPO_PROOF_CHECK" && order.slaDueAt != null && order.slaDueAt < new Date();

  return (
    <>
      <PageHeader
        title={
          <>
            {order.jobCode}
            <StatusChip tone={STATUS_TONE[order.status] ?? "neutral"}>{order.status.replaceAll("_", " ")}</StatusChip>
            {overdue && <StatusChip tone="critical">SLA overdue</StatusChip>}
          </>
        }
        backHref="/artwork"
        backLabel="Artwork queue"
      />

      <div className="flex flex-col gap-6">
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Order</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <ReadOnlyField label="Client" value={order.opportunity.company.name} />
            <ReadOnlyField
              label="Show"
              value={
                <Link href={`/opportunities/${order.opportunityId}`} className="hover:underline">
                  {order.opportunity.showName}
                </Link>
              }
            />
            <ReadOnlyField label="Size" value={order.sizeTier?.label ?? (order.customSizeRequested ? "Custom" : "—")} />
            <ReadOnlyField label="Material" value={order.material} />
            <ReadOnlyField label="Qty" value={String(order.qty)} />
            <ReadOnlyField label="Vendor" value={order.vendor?.name ?? "Not yet assigned"} />
            <ReadOnlyField
              label="Expo-produced art"
              value={order.wantsExpoProducedArt ? `Yes${order.expoProducedFee ? ` — $${order.expoProducedFee}` : ""}` : "No"}
            />
            <ReadOnlyField label="Revision round" value={`${order.revisionRound} of ${2}`} />
          </div>
        </Card>

        {order.customSizeRequested && !order.customQuoteAcceptedAt && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Custom size quote</h2>
            {order.customQuoteAmount ? (
              <p className="text-sm text-neutral-500">
                Quote of ${order.customQuoteAmount.toString()} issued -- awaiting client acceptance before they can
                submit.
              </p>
            ) : (
              <form action={issueQuoteWithId} className="flex flex-wrap items-end gap-3">
                <div className="w-48">
                  <Field label="Quote amount ($)" name="amount" type="number" required />
                </div>
                <Button variant="secondary">Issue quote</Button>
              </form>
            )}
          </Card>
        )}

        {order.status === "UNDER_ART_REVIEW" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Document review</h2>
            {clientArtworkFile ? (
              <p className="mb-4 text-sm">
                <Link
                  href={`/artwork/${order.id}/files/${clientArtworkFile.id}?inline=1`}
                  target="_blank"
                  className="text-neutral-900 underline"
                >
                  View submitted artwork ({clientArtworkFile.filename})
                </Link>
              </p>
            ) : (
              <p className="mb-4 text-sm text-neutral-500">No artwork file found on this order.</p>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <form action={reviewWithId}>
                <input type="hidden" name="decision" value="approve" />
                <Button>Approve</Button>
              </form>
              <form action={reviewWithId} className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end">
                <input type="hidden" name="decision" value="reject" />
                <div className="flex-1">
                  <TextareaField label="Rejection reason" name="reason" rows={1} />
                </div>
                <Button variant="danger">Reject</Button>
              </form>
            </div>
          </Card>
        )}

        {order.status === "ACCEPTED" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Vendor assignment</h2>
            {vendors.length === 0 ? (
              <EmptyState message="No vendors in the catalog yet -- add one before assigning this job." />
            ) : (
              <form action={assignVendorWithId} className="flex flex-wrap items-end gap-3">
                <div className="min-w-64">
                  <SelectField
                    label="Approved vendor"
                    name="vendorId"
                    required
                    options={[{ value: "", label: "Select a vendor…" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
                  />
                </div>
                <Button variant="secondary">Assign &amp; notify</Button>
              </form>
            )}
          </Card>
        )}

        {order.status === "EXPO_PROOF_CHECK" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Proof review — round {order.revisionRound + 1} of {2}
            </h2>
            <p className="mb-2 text-xs text-neutral-500">
              Client cannot see this proof until you clear it here.
              {order.slaDueAt && ` SLA: check due by ${order.slaDueAt.toLocaleString()}.`}
            </p>
            {latestProof && clientArtworkFile ? (
              <div className="mb-4 grid grid-cols-2 gap-4 text-sm">
                <Link
                  href={`/artwork/${order.id}/files/${latestProof.id}?inline=1`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  View proof ({latestProof.filename})
                </Link>
                <Link
                  href={`/artwork/${order.id}/files/${clientArtworkFile.id}?inline=1`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  View approved artwork
                </Link>
              </div>
            ) : (
              <p className="mb-4 text-sm text-neutral-500">Missing a proof or approved-artwork file to compare.</p>
            )}
            <div className="flex flex-col gap-3">
              <form action={confirmMatchWithId}>
                <Button>✔ Matches approved artwork — release to client</Button>
              </form>
              <form action={requestRevisionWithId} className="flex flex-col gap-2">
                <TextareaField
                  label="Mismatch note (relayed to vendor as an &quot;Expo review note&quot;)"
                  name="note"
                  rows={2}
                  required
                />
                <Button variant="danger">✘ Request revision</Button>
              </form>
            </div>
          </Card>
        )}

        {order.status === "ESCALATED" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Escalated — revision cap (2) reached
            </h2>
            <p className="mb-4 text-sm text-neutral-500">
              This job needs manual resolution before it can re-enter the proof cycle. This note is visible only to
              this opportunity&apos;s owner, collaborators, and admins.
            </p>
            <form action={resolveEscalationWithId} className="flex flex-col gap-3">
              <Field label="Who was contacted" name="contactedWho" required />
              <SelectField
                label="Outcome"
                name="outcome"
                required
                options={[
                  { value: "", label: "Select an outcome…" },
                  { value: "revised quote issued", label: "Revised quote issued" },
                  { value: "client cancelled", label: "Client cancelled" },
                  { value: "held at original price", label: "Held at original price" },
                ]}
              />
              <TextareaField label="Note" name="note" rows={3} />
              <Button variant="secondary">Log &amp; reset revision count</Button>
            </form>
          </Card>
        )}

        {order.status === "PROOF_APPROVED" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Production go-ahead</h2>
            <p className="mb-4 text-sm text-neutral-500">
              The client has signed off. Only Expo can issue the final go-ahead to the vendor.
            </p>
            <form action={issueGoAheadWithId}>
              <Button>Issue go-ahead to vendor</Button>
            </form>
          </Card>
        )}

        {order.status === "SHIPPED_TO_SHOW" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Delivery</h2>
            <p className="mb-4 text-sm text-neutral-500">
              Vendor has marked this shipped. Only Expo marks delivery, since Expo has show-site visibility.
            </p>
            <form action={markDeliveredWithId}>
              <Button>Mark arrived / delivered to booth</Button>
            </form>
          </Card>
        )}

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Files</h2>
          {order.files.length === 0 ? (
            <EmptyState message="No files uploaded yet." />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {order.files.map((f) => (
                <li key={f.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                  <span>
                    {f.filename} <span className="text-neutral-400">({f.kind === "PROOF" ? `proof round ${f.round}` : "client artwork"})</span>
                  </span>
                  <Link href={`/artwork/${order.id}/files/${f.id}`} className="text-neutral-900 hover:underline">
                    Download →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Activity</h2>
          {order.events.length === 0 ? (
            <EmptyState message="No activity yet." />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {order.events.map((e) => (
                <li key={e.id} className="rounded-md bg-neutral-50 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{e.action.replaceAll("_", " ")}</span>
                    <span className="text-xs text-neutral-400">{e.createdAt.toLocaleString()}</span>
                  </div>
                  <div className="text-xs text-neutral-500">
                    {e.actorType} {e.fromStatus ? `${e.fromStatus} → ${e.toStatus}` : e.toStatus}
                  </div>
                  {e.note && <div className="mt-1 text-neutral-700">{e.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
