import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { validatePortalToken } from "@/lib/artwork-portal-auth";
import { Card, ReadOnlyField, Button, StatusChip } from "@/components/ui";
import { ArtworkUploadForm } from "@/components/artwork-upload-form";
import { markPackagedAction, markSentToProductionAction, markShippedAction, uploadProofAction } from "./actions";

export const dynamic = "force-dynamic";

// Deliberately selects ONLY fields safe to show a vendor -- no opportunity,
// company, or contact relation is ever included in this query. This is the
// concrete mechanism behind the vendor-anonymity rule in this direction
// (see ArtworkOrder's own schema comment): there's nothing here for a page
// bug to accidentally leak, because the client's identity was never
// fetched in the first place.
async function getVendorPortalView(artworkOrderId: string) {
  const order = await db.artworkOrder.findUniqueOrThrow({
    where: { id: artworkOrderId },
    select: {
      id: true,
      jobCode: true,
      status: true,
      material: true,
      qty: true,
      revisionRound: true,
      sizeTier: { select: { label: true, width: true, height: true } },
      customWidth: true,
      customHeight: true,
      customSizeRequested: true,
    },
  });
  const clientArtworkFile = await db.artworkFile.findFirst({
    where: { artworkOrderId, kind: "CLIENT_ARTWORK", deletedAt: null },
    select: { id: true, filename: true },
  });
  const latestProof = await db.artworkFile.findFirst({
    where: { artworkOrderId, kind: "PROOF", deletedAt: null },
    orderBy: { round: "desc" },
    select: { id: true, filename: true, round: true },
  });
  // Unified "Expo review note" per the spec's vendor-anonymity principle in
  // the OTHER direction too -- a vendor must never learn whether a
  // revision note came from Expo's own check or a rare client rejection,
  // so only .note is ever read here, never actorType/actorEmail.
  const latestReviewNote =
    order.status === "PROOF_REVISION_REQUESTED"
      ? await db.artworkOrderEvent.findFirst({
          where: { artworkOrderId, action: { in: ["REQUEST_REVISION", "CLIENT_REPORTED_MISMATCH"] } },
          orderBy: { createdAt: "desc" },
          select: { note: true },
        })
      : null;

  return { order, clientArtworkFile, latestProof, latestReviewNote };
}

export default async function VendorPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const identity = await validatePortalToken(token);
  if (!identity || identity.role !== "VENDOR") notFound();

  const { order, clientArtworkFile, latestProof, latestReviewNote } = await getVendorPortalView(identity.artworkOrderId);

  const uploadWithToken = uploadProofAction.bind(null, token);
  const markSentWithToken = markSentToProductionAction.bind(null, token);
  const markPackagedWithToken = markPackagedAction.bind(null, token);
  const markShippedWithToken = markShippedAction.bind(null, token);

  const sizeLabel = order.sizeTier?.label ?? (order.customSizeRequested ? `${order.customWidth ?? "?"}" x ${order.customHeight ?? "?"}"` : "—");
  const needsProof = order.status === "PROOF_IN_PROGRESS" || order.status === "PROOF_REVISION_REQUESTED";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl tracking-wide">Job {order.jobCode}</h1>
        <p className="text-sm text-neutral-500">No client company or contact information is shown -- Expo brokers all communication.</p>
      </div>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Job spec</h2>
        <div className="grid grid-cols-2 gap-4">
          <ReadOnlyField label="Size" value={sizeLabel} />
          <ReadOnlyField label="Material" value={order.material} />
          <ReadOnlyField label="Qty" value={String(order.qty)} />
          <ReadOnlyField label="Status" value={<StatusChip tone="info">{order.status.replaceAll("_", " ")}</StatusChip>} />
        </div>
        {clientArtworkFile && (
          <a
            href={`/vendor-portal/${token}/files/${clientArtworkFile.id}?inline=1`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block text-sm text-neutral-900 underline"
          >
            Download print-ready artwork
          </a>
        )}
      </Card>

      {needsProof && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {order.status === "PROOF_REVISION_REQUESTED" ? "Revise your proof" : "Upload proof"}
          </h2>
          {latestReviewNote?.note && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span className="font-medium">Expo review note:</span> {latestReviewNote.note}
            </div>
          )}
          <ArtworkUploadForm
            artworkOrderId={order.id}
            uploadTokenUrl={`/vendor-portal/${token}/upload-token`}
            finalizeUpload={uploadWithToken}
            submitLabel="Submit Proof"
          />
        </Card>
      )}

      {!needsProof && order.status !== "PRODUCTION_GO_AHEAD" && order.status !== "IN_PRODUCTION" && order.status !== "PACKAGED_READY" && order.status !== "SHIPPED_TO_SHOW" && order.status !== "DELIVERED_AT_SHOW" && (
        <Card className="p-6 text-center text-sm text-neutral-500">
          {latestProof ? `Proof submitted (${latestProof.filename}) — waiting on Expo's review.` : "Waiting on Expo."}
        </Card>
      )}

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Production status</h2>
        <ul className="mb-4 flex flex-col gap-1 text-sm">
          <li>{["PRODUCTION_GO_AHEAD", "IN_PRODUCTION", "PACKAGED_READY", "SHIPPED_TO_SHOW", "DELIVERED_AT_SHOW"].includes(order.status) ? "✔" : "○"} Awaiting Go-Ahead</li>
          <li>{["IN_PRODUCTION", "PACKAGED_READY", "SHIPPED_TO_SHOW", "DELIVERED_AT_SHOW"].includes(order.status) ? "✔" : "○"} Sent to production</li>
          <li>{["PACKAGED_READY", "SHIPPED_TO_SHOW", "DELIVERED_AT_SHOW"].includes(order.status) ? "✔" : "○"} Packaged / ready</li>
          <li>{["SHIPPED_TO_SHOW", "DELIVERED_AT_SHOW"].includes(order.status) ? "✔" : "○"} Shipped to show</li>
        </ul>
        {order.status === "PRODUCTION_GO_AHEAD" && (
          <form action={markSentWithToken}>
            <Button>Mark Complete (sent to production)</Button>
          </form>
        )}
        {order.status === "IN_PRODUCTION" && (
          <form action={markPackagedWithToken}>
            <Button>Mark Shipped (packaged / ready)</Button>
          </form>
        )}
        {order.status === "PACKAGED_READY" && (
          <form action={markShippedWithToken}>
            <Button>Mark shipped to show</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
