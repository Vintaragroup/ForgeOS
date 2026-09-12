"use server";

import { revalidatePath } from "next/cache";
import { validatePortalToken, type PortalIdentity } from "@/lib/artwork-portal-auth";
import { transitionArtworkOrder, uploadProof } from "@/lib/artwork-order-service";
import { finalizeArtworkUpload } from "@/lib/artwork-file-service";
import { notifyReviewersProofReady, notifyShipped } from "@/lib/artwork-notifications";
import { db } from "@/lib/db";

async function requireVendorIdentity(token: string): Promise<PortalIdentity> {
  const identity = await validatePortalToken(token);
  if (!identity || identity.role !== "VENDOR") throw new Error("Portal access denied.");
  return identity;
}

function actor(identity: PortalIdentity) {
  return { type: "VENDOR" as const, email: identity.email };
}

// Handles both the first proof upload (status PROOF_IN_PROGRESS already)
// and a revision re-upload (status PROOF_REVISION_REQUESTED, which must
// pass through PROOF_IN_PROGRESS first per the diagram -- "Vendor revises
// proof") -- one action covers both since the vendor's own experience
// ("upload a proof") is identical either way.
export async function uploadProofAction(
  token: string,
  data: { storageKey: string; filename: string; mimeType: string; sizeBytes: number },
) {
  const identity = await requireVendorIdentity(token);
  const order = await db.artworkOrder.findUniqueOrThrow({ where: { id: identity.artworkOrderId } });

  if (order.status === "PROOF_REVISION_REQUESTED") {
    await transitionArtworkOrder(identity.artworkOrderId, "PROOF_IN_PROGRESS", "VENDOR_REVISING", actor(identity));
  }
  await finalizeArtworkUpload(identity.artworkOrderId, {
    storageKey: data.storageKey,
    kind: "PROOF",
    round: order.revisionRound,
    originalFilename: data.filename,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    uploadedByType: "VENDOR",
    uploadedByEmail: identity.email,
  });
  const { artworkOrder } = await uploadProof(identity.artworkOrderId, actor(identity));
  await notifyReviewersProofReady(artworkOrder.opportunityId, artworkOrder.jobCode);
  revalidatePath(`/vendor-portal/${token}`);
}

export async function markSentToProductionAction(token: string) {
  const identity = await requireVendorIdentity(token);
  await transitionArtworkOrder(identity.artworkOrderId, "IN_PRODUCTION", "SENT_TO_PRODUCTION", actor(identity));
  revalidatePath(`/vendor-portal/${token}`);
}

export async function markPackagedAction(token: string) {
  const identity = await requireVendorIdentity(token);
  await transitionArtworkOrder(identity.artworkOrderId, "PACKAGED_READY", "PACKAGED", actor(identity));
  revalidatePath(`/vendor-portal/${token}`);
}

export async function markShippedAction(token: string) {
  const identity = await requireVendorIdentity(token);
  const { artworkOrder } = await transitionArtworkOrder(identity.artworkOrderId, "SHIPPED_TO_SHOW", "SHIPPED", actor(identity));
  const clientInvite = await db.artworkPortalInvite.findFirst({
    where: { artworkOrderId: identity.artworkOrderId, role: "CLIENT" },
    orderBy: { createdAt: "desc" },
    select: { email: true },
  });
  if (clientInvite) {
    await notifyShipped(artworkOrder.opportunityId, artworkOrder.id, artworkOrder.jobCode, clientInvite.email);
  }
  revalidatePath(`/vendor-portal/${token}`);
}
