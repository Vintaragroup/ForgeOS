"use server";

import { revalidatePath } from "next/cache";
import { requireArtworkOrderAccess } from "@/lib/opportunity-access";
import {
  acceptArtworkOrder,
  assignVendor,
  setCustomSizeQuote,
  transitionArtworkOrder,
} from "@/lib/artwork-order-service";
import {
  notifyClientAccepted,
  notifyClientDelivered,
  notifyClientProofReady,
  notifyClientRejected,
  notifyReviewersEscalation,
  notifyVendorAssigned,
  notifyVendorGoAhead,
  notifyVendorRevisionRequested,
} from "@/lib/artwork-notifications";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { ArtworkPortalRole } from "@/generated/prisma/enums";

async function expoActor(artworkOrderId: string) {
  const user = await requireArtworkOrderAccess(artworkOrderId);
  return { type: "EXPO" as const, userId: user.id };
}

// Only tokenHash is ever persisted (see ArtworkPortalInvite's schema
// comment), but the plain email address IS -- this reads back "who did we
// last invite in this role" so a later notification (a rejection, a
// go-ahead, ...) knows who to email without needing the original raw token.
async function latestInviteEmail(artworkOrderId: string, role: ArtworkPortalRole): Promise<string | null> {
  const invite = await db.artworkPortalInvite.findFirst({
    where: { artworkOrderId, role },
    orderBy: { createdAt: "desc" },
    select: { email: true },
  });
  return invite?.email ?? null;
}

export async function reviewArtworkOrderAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const decision = String(formData.get("decision") ?? "");
  const clientEmail = await latestInviteEmail(artworkOrderId, "CLIENT");
  if (decision === "approve") {
    await acceptArtworkOrder(artworkOrderId, actor);
    if (clientEmail) await notifyClientAccepted(artworkOrderId, clientEmail);
  } else if (decision === "reject") {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new Error("A rejection reason is required.");
    await transitionArtworkOrder(artworkOrderId, "REJECTED", "REJECT", actor, { note: reason });
    if (clientEmail) await notifyClientRejected(artworkOrderId, clientEmail, reason);
  } else {
    throw new Error("Unknown review decision.");
  }
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function issueCustomQuoteAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const amount = Number(formData.get("amount"));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid quote amount.");
  await setCustomSizeQuote(artworkOrderId, amount, actor);
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function assignVendorAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const vendorId = String(formData.get("vendorId") ?? "").trim();
  if (!vendorId) throw new Error("Select a vendor to assign.");
  const vendor = await db.vendor.findUniqueOrThrow({ where: { id: vendorId } });
  if (!vendor.email) throw new Error(`${vendor.name} has no email on file -- add one before assigning this job.`);
  const { artworkOrder } = await assignVendor(artworkOrderId, vendorId, actor);
  await notifyVendorAssigned(artworkOrderId, vendor.email, artworkOrder.jobCode);
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function confirmProofMatchAction(artworkOrderId: string) {
  const actor = await expoActor(artworkOrderId);
  await transitionArtworkOrder(artworkOrderId, "PROOF_UNDER_REVIEW", "CONFIRM_MATCH", actor);
  const clientEmail = await latestInviteEmail(artworkOrderId, "CLIENT");
  if (clientEmail) await notifyClientProofReady(artworkOrderId, clientEmail);
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function requestProofRevisionAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const note = String(formData.get("note") ?? "").trim();
  if (!note) throw new Error("A revision note is required -- it's relayed to the vendor as an \"Expo review note.\"");
  const { artworkOrder, escalated } = await transitionArtworkOrder(
    artworkOrderId,
    "PROOF_REVISION_REQUESTED",
    "REQUEST_REVISION",
    actor,
    { note },
  );
  if (escalated) {
    await notifyReviewersEscalation(artworkOrder.opportunityId, artworkOrder.jobCode);
  } else {
    const vendorEmail = await latestInviteEmail(artworkOrderId, "VENDOR");
    if (vendorEmail) await notifyVendorRevisionRequested(artworkOrderId, vendorEmail, note);
  }
  revalidatePath(`/artwork/${artworkOrderId}`);
}

// Non-negotiable per the spec's resolved decision: a structured resolution
// note (who was contacted, the outcome, and a free-text note) is required
// before an escalated order can re-enter ProofInProgress --
// transitionArtworkOrder itself also enforces that opts.detail is present
// and forces the resulting event's restrictedToInternal flag, but the shape
// of that detail is this action's responsibility to collect correctly.
export async function resolveEscalationAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const contactedWho = String(formData.get("contactedWho") ?? "").trim();
  const outcome = String(formData.get("outcome") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!contactedWho || !outcome) throw new Error("Who was contacted and the outcome are both required.");
  await transitionArtworkOrder(artworkOrderId, "PROOF_IN_PROGRESS", "ESCALATION_RESOLVED", actor, {
    detail: { contactedWho, outcome, note } as Prisma.InputJsonValue,
  });
  revalidatePath(`/artwork/${artworkOrderId}`);
}

// Business-rule-correct trigger for the vendor's "go-ahead" notification
// (row 9 of the notification matrix) -- see notifyVendorGoAhead's own
// comment for why this is fired from here, not from the client's sign-off.
export async function issueProductionGoAheadAction(artworkOrderId: string) {
  const actor = await expoActor(artworkOrderId);
  await transitionArtworkOrder(artworkOrderId, "PRODUCTION_GO_AHEAD", "ISSUE_GO_AHEAD", actor);
  const vendorEmail = await latestInviteEmail(artworkOrderId, "VENDOR");
  if (vendorEmail) await notifyVendorGoAhead(artworkOrderId, vendorEmail);
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function markDeliveredAction(artworkOrderId: string) {
  const actor = await expoActor(artworkOrderId);
  await transitionArtworkOrder(artworkOrderId, "DELIVERED_AT_SHOW", "DELIVERED", actor);
  const clientEmail = await latestInviteEmail(artworkOrderId, "CLIENT");
  if (clientEmail) await notifyClientDelivered(artworkOrderId, clientEmail);
  revalidatePath(`/artwork/${artworkOrderId}`);
}
