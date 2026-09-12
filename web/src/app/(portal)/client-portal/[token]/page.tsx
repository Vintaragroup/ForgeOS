import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { validatePortalToken } from "@/lib/artwork-portal-auth";
import { Card, Field, SelectField, TextareaField, Button, StatusChip } from "@/components/ui";
import { ArtworkUploadForm } from "@/components/artwork-upload-form";
import {
  acceptCustomQuoteAction,
  approveProofAction,
  finalizeArtworkUploadAction,
  reportProofMismatchAction,
  startOrRestartOrderAction,
  submitOrderAction,
  updateOrderDetailsAction,
} from "./actions";

export const dynamic = "force-dynamic";

// Wireframe 6.4's status tracker, collapsed to the statuses a client ever
// actually sees themselves (everything between VendorAssigned and
// ProofUnderReview happens entirely behind the vendor-anonymity curtain).
const CLIENT_STEPS = [
  { key: "SUBMITTED", label: "Submitted" },
  { key: "ACCEPTED", label: "Artwork accepted" },
  { key: "PROOF_UNDER_REVIEW", label: "Proof under review" },
  { key: "IN_PRODUCTION", label: "In production" },
  { key: "SHIPPED_TO_SHOW", label: "Shipped to show" },
  { key: "DELIVERED_AT_SHOW", label: "Delivered to booth" },
] as const;

// Maps every real status onto the highest client-visible step it implies --
// e.g. VendorAssigned/ProofInProgress/ProofSubmitted/ExpoProofCheck are all
// "still working on the proof," shown as still at Accepted from the
// client's own point of view.
const STEP_INDEX: Record<string, number> = {
  SUBMITTED: 0,
  UNDER_ART_REVIEW: 0,
  ACCEPTED: 1,
  VENDOR_ASSIGNED: 1,
  PROOF_IN_PROGRESS: 1,
  PROOF_SUBMITTED: 1,
  EXPO_PROOF_CHECK: 1,
  PROOF_REVISION_REQUESTED: 1,
  ESCALATED: 1,
  PROOF_UNDER_REVIEW: 2,
  PROOF_APPROVED: 3,
  PRODUCTION_GO_AHEAD: 3,
  IN_PRODUCTION: 3,
  PACKAGED_READY: 3,
  SHIPPED_TO_SHOW: 4,
  DELIVERED_AT_SHOW: 5,
};

export default async function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const identity = await validatePortalToken(token);
  if (!identity || identity.role !== "CLIENT") notFound();

  const order = await db.artworkOrder.findUniqueOrThrow({
    where: { id: identity.artworkOrderId },
    include: {
      opportunity: { include: { company: true } },
      sizeTier: true,
      files: { where: { deletedAt: null, kind: "CLIENT_ARTWORK" }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const latestProof = await db.artworkFile.findFirst({
    where: { artworkOrderId: order.id, kind: "PROOF", deletedAt: null },
    orderBy: { round: "desc" },
  });
  const sizeTiers = await db.artworkSizeTier.findMany({ where: { deletedAt: null, isStandard: true }, orderBy: { label: "asc" } });

  const startOrRestartWithToken = startOrRestartOrderAction.bind(null, token);
  const updateDetailsWithToken = updateOrderDetailsAction.bind(null, token);
  const acceptQuoteWithToken = acceptCustomQuoteAction.bind(null, token);
  const finalizeUploadWithToken = finalizeArtworkUploadAction.bind(null, token);
  const submitOrderWithToken = submitOrderAction.bind(null, token);
  const approveProofWithToken = approveProofAction.bind(null, token);
  const reportMismatchWithToken = reportProofMismatchAction.bind(null, token);

  const isDrafting = order.status === "INVITED" || order.status === "ORDER_DRAFTED" || order.status === "REJECTED";
  const clientArtworkFile = order.files[0];
  const canSubmit = clientArtworkFile != null && (!order.customSizeRequested || order.customQuoteAcceptedAt != null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl tracking-wide">{order.opportunity.showName}</h1>
        <p className="text-sm text-neutral-500">
          {order.opportunity.company.name}
          {order.opportunity.boothNumber && ` — Booth ${order.opportunity.boothNumber}`}
        </p>
      </div>

      {order.status === "REJECTED" && (
        <Card className="border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">Your submission needs changes before it can move forward.</p>
          <form action={startOrRestartWithToken} className="mt-3">
            <Button variant="secondary">Revise and resubmit</Button>
          </form>
        </Card>
      )}

      {order.status === "INVITED" && (
        <Card className="p-6 text-center">
          <p className="mb-4 text-sm text-neutral-600">Ready to start your artwork order?</p>
          <form action={startOrRestartWithToken}>
            <Button>Start Order</Button>
          </form>
        </Card>
      )}

      {isDrafting && order.status !== "INVITED" && order.status !== "REJECTED" && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Order details</h2>
          <form action={updateDetailsWithToken} className="flex flex-col gap-4">
            <SelectField
              label="Size"
              name="sizeTierId"
              defaultValue={order.sizeTierId ?? ""}
              options={[{ value: "", label: "Select a size…" }, ...sizeTiers.map((t) => ({ value: t.id, label: t.label }))]}
            />
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" name="customSizeRequested" defaultChecked={order.customSizeRequested} />
              Request a custom size instead
            </label>
            {order.customSizeRequested && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Width (in)" name="customWidth" type="number" defaultValue={order.customWidth?.toString()} />
                <Field label="Height (in)" name="customHeight" type="number" defaultValue={order.customHeight?.toString()} />
              </div>
            )}
            <Field label="Material" name="material" defaultValue={order.material ?? ""} />
            <Field label="Quantity" name="qty" type="number" defaultValue={String(order.qty)} />
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" name="wantsExpoProducedArt" defaultChecked={order.wantsExpoProducedArt} />
              I want Expo to produce my print-ready artwork (fee applies based on size)
            </label>
            <Button variant="secondary">Save details</Button>
          </form>

          {order.customSizeRequested && (
            <div className="mt-4 rounded-md border border-neutral-200 p-4">
              {order.customQuoteAmount == null ? (
                <p className="text-sm text-neutral-500">
                  Quote Pending — Expo is preparing a custom price quote. You cannot submit until it&apos;s issued and
                  accepted here.
                </p>
              ) : order.customQuoteAcceptedAt == null ? (
                <>
                  <p className="mb-3 text-sm">Custom quote: ${order.customQuoteAmount.toString()}</p>
                  <form action={acceptQuoteWithToken}>
                    <Button>Accept quote</Button>
                  </form>
                </>
              ) : (
                <p className="text-sm text-green-700">Quote of ${order.customQuoteAmount.toString()} accepted.</p>
              )}
            </div>
          )}

          <div className="mt-6 border-t border-neutral-200 pt-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Artwork</h3>
            {clientArtworkFile && <p className="mb-3 text-sm text-neutral-600">Uploaded: {clientArtworkFile.filename}</p>}
            <ArtworkUploadForm
              artworkOrderId={order.id}
              uploadTokenUrl={`/client-portal/${token}/upload-token`}
              finalizeUpload={finalizeUploadWithToken}
              submitLabel="Upload artwork"
            />
          </div>

          <form action={submitOrderWithToken} className="mt-6">
            <Button disabled={!canSubmit}>Submit Order</Button>
          </form>
        </Card>
      )}

      {!isDrafting && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Order status</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {CLIENT_STEPS.map((step, i) => {
              const current = STEP_INDEX[order.status] ?? 0;
              const done = i < current || order.status === "DELIVERED_AT_SHOW";
              const active = i === current && order.status !== "DELIVERED_AT_SHOW";
              return (
                <li key={step.key} className="flex items-center gap-2">
                  <span>{done ? "✔" : active ? "●" : "○"}</span>
                  <span className={active ? "font-medium" : ""}>{step.label}</span>
                  {active && <StatusChip tone="info">you are here</StatusChip>}
                </li>
              );
            })}
          </ul>

          {order.status === "PROOF_UNDER_REVIEW" && latestProof && (
            <div className="mt-6 border-t border-neutral-200 pt-4">
              <p className="mb-3 text-sm text-neutral-600">
                This proof has been reviewed by your account manager and matches your approved artwork.
              </p>
              <a
                href={`/client-portal/${token}/files/${latestProof.id}?inline=1`}
                target="_blank"
                rel="noreferrer"
                className="mb-4 inline-block text-sm text-neutral-900 underline"
              >
                View proof
              </a>
              <div className="flex flex-col gap-3">
                <form action={approveProofWithToken}>
                  <Button>Approve — Send to Production</Button>
                </form>
                <form action={reportMismatchWithToken} className="flex flex-col gap-2">
                  <TextareaField
                    label="Report a mismatch (only for genuine artwork discrepancies, not general revisions)"
                    name="note"
                    rows={2}
                  />
                  <Button variant="danger">Report a Mismatch</Button>
                </form>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
