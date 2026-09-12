"use server";

import { revalidatePath } from "next/cache";
import { validatePortalToken, type PortalIdentity } from "@/lib/artwork-portal-auth";
import {
  acceptCustomSizeQuote,
  submitArtworkOrder,
  transitionArtworkOrder,
  updateArtworkOrderDraft,
} from "@/lib/artwork-order-service";
import { finalizeArtworkUpload } from "@/lib/artwork-file-service";
import { notifyReviewersEscalation, notifyReviewersOfSubmission, notifyVendorRevisionRequested } from "@/lib/artwork-notifications";
import { db } from "@/lib/db";

// Every action here only ever receives the token itself, not a separate
// artworkOrderId -- the token IS the sole identifier of which order this
// visitor may act on, so validating it is the whole access check (unlike
// requirePortalAccess, which exists for the file route below where a
// SEPARATE fileId also needs to be proven to belong to this same order).
async function requireClientIdentity(token: string): Promise<PortalIdentity> {
  const identity = await validatePortalToken(token);
  if (!identity || identity.role !== "CLIENT") throw new Error("Portal access denied.");
  return identity;
}

function actor(identity: PortalIdentity) {
  return { type: "CLIENT" as const, email: identity.email };
}

// Opens a fresh draft (from Invited) or reopens one after a rejection (from
// Rejected) -- both are legal edges to OrderDrafted in the same table, the
// only difference is the action label recorded on the audit event.
export async function startOrRestartOrderAction(token: string) {
  const identity = await requireClientIdentity(token);
  const order = await db.artworkOrder.findUniqueOrThrow({ where: { id: identity.artworkOrderId } });
  const action = order.status === "REJECTED" ? "RESUBMIT" : "OPEN_PORTAL";
  await transitionArtworkOrder(identity.artworkOrderId, "ORDER_DRAFTED", action, actor(identity));
  revalidatePath(`/client-portal/${token}`);
}

export async function updateOrderDetailsAction(token: string, formData: FormData) {
  const identity = await requireClientIdentity(token);
  const sizeTierId = String(formData.get("sizeTierId") ?? "").trim();
  const customSizeRequested = formData.get("customSizeRequested") === "on";
  await updateArtworkOrderDraft(identity.artworkOrderId, {
    sizeTierId: customSizeRequested ? null : sizeTierId || null,
    customSizeRequested,
    customWidth: customSizeRequested ? Number(formData.get("customWidth")) || null : null,
    customHeight: customSizeRequested ? Number(formData.get("customHeight")) || null : null,
    material: String(formData.get("material") ?? "").trim() || null,
    qty: Number(formData.get("qty")) || 1,
    wantsExpoProducedArt: formData.get("wantsExpoProducedArt") === "on",
  });
  revalidatePath(`/client-portal/${token}`);
}

export async function acceptCustomQuoteAction(token: string) {
  const identity = await requireClientIdentity(token);
  await acceptCustomSizeQuote(identity.artworkOrderId, actor(identity));
  revalidatePath(`/client-portal/${token}`);
}

export async function finalizeArtworkUploadAction(
  token: string,
  data: { storageKey: string; filename: string; mimeType: string; sizeBytes: number },
) {
  const identity = await requireClientIdentity(token);
  await finalizeArtworkUpload(identity.artworkOrderId, {
    storageKey: data.storageKey,
    kind: "CLIENT_ARTWORK",
    round: 0,
    originalFilename: data.filename,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    uploadedByType: "CLIENT",
    uploadedByEmail: identity.email,
  });
  revalidatePath(`/client-portal/${token}`);
}

export async function submitOrderAction(token: string) {
  const identity = await requireClientIdentity(token);
  const { artworkOrder } = await submitArtworkOrder(identity.artworkOrderId, actor(identity));
  await notifyReviewersOfSubmission(artworkOrder.opportunityId, artworkOrder.jobCode);
  revalidatePath(`/client-portal/${token}`);
}

export async function approveProofAction(token: string) {
  const identity = await requireClientIdentity(token);
  await transitionArtworkOrder(identity.artworkOrderId, "PROOF_APPROVED", "CLIENT_SIGN_OFF", actor(identity));
  revalidatePath(`/client-portal/${token}`);
}

// Rare per the spec (~1% of cases) -- Expo's own check already stands as
// the primary gate, so this is only for a genuine mismatch Expo missed,
// not general dissatisfaction with artwork the client already approved.
// Reuses the exact same PROOF_REVISION_REQUESTED path Expo's own mismatch
// flow uses, including the shared revision-round cap/escalation logic.
export async function reportProofMismatchAction(token: string, formData: FormData) {
  const identity = await requireClientIdentity(token);
  const note = String(formData.get("note") ?? "").trim();
  if (!note) throw new Error("Describe the mismatch you're seeing.");
  const { artworkOrder, escalated } = await transitionArtworkOrder(
    identity.artworkOrderId,
    "PROOF_REVISION_REQUESTED",
    "CLIENT_REPORTED_MISMATCH",
    actor(identity),
    { note },
  );
  if (escalated) {
    await notifyReviewersEscalation(artworkOrder.opportunityId, artworkOrder.jobCode);
  } else {
    const vendorInvite = await db.artworkPortalInvite.findFirst({
      where: { artworkOrderId: identity.artworkOrderId, role: "VENDOR" },
      orderBy: { createdAt: "desc" },
      select: { email: true },
    });
    // Unified as a generic "Expo review note" -- the vendor never learns
    // this one came from the client rather than Expo's own check.
    if (vendorInvite) await notifyVendorRevisionRequested(identity.artworkOrderId, vendorInvite.email, note);
  }
  revalidatePath(`/client-portal/${token}`);
}
