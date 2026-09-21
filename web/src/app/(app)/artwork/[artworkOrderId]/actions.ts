"use server";

import { setArtworkRouting, setHalfProductionStatus, type RoutingInput } from "@/lib/artwork-routing";
import { revalidatePath } from "next/cache";
import type { ArtworkOrderType, ArtworkProductionStatus } from "@/generated/prisma/enums";
import { requireArtworkOrderAccess } from "@/lib/opportunity-access";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";
import {
  acceptArtworkOrder,
  assignVendor,
  recordAgingDecision,
  recordPostShowDisposition,
  setCustomSizeQuote,
  setProductionDetail,
  setProductionSpec,
  transitionArtworkOrder,
} from "@/lib/artwork-order-service";
import type {
  ExistingGraphicsStatus,
  PostShowCondition,
  PostShowDiscardReason,
  PostShowStatus,
} from "@/generated/prisma/enums";
import {
  notifyClientAccepted,
  notifyClientDelivered,
  notifyClientOfDamagedAsset,
  notifyClientProofReady,
  notifyClientRejected,
  notifyGraphicsOfDamagedAsset,
  notifyReviewersEscalation,
  notifySalesOfAgingAsset,
  notifyVendorAssigned,
  notifyVendorGoAhead,
  notifyVendorRevisionRequested,
} from "@/lib/artwork-notifications";
import { createAnnotation, resolveAnnotation } from "@/lib/artwork-annotation-service";
import { finalizeArtworkUpload } from "@/lib/artwork-file-service";
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

// A plain edit form always resubmits all three fields together -- unlike
// setProductionSpec's own three-way-independent-undefined shape (meant for
// callers that only touch one field, e.g. an auto-prefill from the
// uploaded file), this action treats a blank input as "clear this field,"
// not "leave unchanged," since there's no way for a submitted HTML form to
// signal the difference.
function parseOptionalInches(formData: FormData, name: string): number | null {
  const raw = String(formData.get(name) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Enter a valid ${name === "bleedIn" ? "bleed" : "dimension"} in inches.`);
  return n;
}

export async function setProductionSpecAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  await setProductionSpec(
    artworkOrderId,
    {
      widthIn: parseOptionalInches(formData, "widthIn"),
      heightIn: parseOptionalInches(formData, "heightIn"),
      bleedIn: parseOptionalInches(formData, "bleedIn"),
    },
    actor,
  );
  revalidatePath(`/artwork/${artworkOrderId}`);
}

const EXISTING_GRAPHICS_STATUS_VALUES: readonly ExistingGraphicsStatus[] = [
  "NEW_IMAGE",
  "EXISTING",
  "DAMAGED",
  "NOT_EXISTING",
];

// Same "a plain edit form always resubmits everything together" posture as
// setProductionSpecAction just above -- a blank field means "clear it,"
// not "leave unchanged" (there's no way for a submitted HTML form to
// signal that distinction), so every field here is always written, never
// left as `undefined`.
export async function setProductionDetailAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const rawExistingStatus = String(formData.get("existingGraphicsStatus") ?? "").trim();
  const rawArtDue = String(formData.get("artDueDate") ?? "").trim();
  const rawInHand = String(formData.get("inHandDate") ?? "").trim();
  const rawOrderType = String(formData.get("orderType") ?? "").trim();
  const rawQty = String(formData.get("qty") ?? "").trim();
  const qty = rawQty ? Number(rawQty) : 1;
  if (!Number.isFinite(qty) || qty < 1) throw new Error("Enter a valid quantity.");

  await setProductionDetail(
    artworkOrderId,
    {
      material: String(formData.get("material") ?? "").trim() || null,
      qty,
      graphicCode: String(formData.get("graphicCode") ?? "").trim() || null,
      finishingDetails: String(formData.get("finishingDetails") ?? "").trim() || null,
      artDueDate: rawArtDue ? new Date(rawArtDue) : null,
      inHandDate: rawInHand ? new Date(rawInHand) : null,
      orderType: (rawOrderType || null) as ArtworkOrderType | null,
      existingGraphicsStatus: EXISTING_GRAPHICS_STATUS_VALUES.includes(rawExistingStatus as ExistingGraphicsStatus)
        ? (rawExistingStatus as ExistingGraphicsStatus)
        : null,
      verifiedSizes: formData.get("verifiedSizes") === "on",
      designerId: String(formData.get("designerId") ?? "").trim() || null,
    },
    actor,
  );
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function setRoutingAction(
  artworkOrderId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  await expoActor(artworkOrderId);
  return catchUserError(async () => {
    const entries: RoutingInput[] = [];
    if (formData.get("inHouse")) {
      entries.push({ kind: "EXPO_IN_HOUSE", officeCode: String(formData.get("officeCode") ?? "").trim() || null });
    }
    for (const id of formData.getAll("vendorIds")) {
      const vendorId = String(id).trim();
      if (vendorId) entries.push({ kind: "VENDOR", vendorId });
    }
    if (formData.get("amPm")) {
      entries.push({ kind: "AM_PM_COORDINATED", note: String(formData.get("amPmNote") ?? "") });
    }
    await setArtworkRouting(artworkOrderId, entries);
    revalidatePath(`/artwork/${artworkOrderId}`);
  });
}

export async function setHalfStatusAction(
  artworkOrderId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  await expoActor(artworkOrderId);
  return catchUserError(async () => {
    const routingId = String(formData.get("routingId") ?? "").trim();
    const status = String(formData.get("status") ?? "").trim();
    if (!routingId || !status) throw new UserError("Pick a status.");
    await setHalfProductionStatus(routingId, status as ArtworkProductionStatus);
    revalidatePath(`/artwork/${artworkOrderId}`);
  });
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

const POST_SHOW_STATUS_VALUES: readonly PostShowStatus[] = ["NOT_RECEIVED", "EXPO_STORAGE", "SHIP_TO_CLIENT", "DISCARDED"];
// PRODUCT deliberately excluded -- deprecated, never offered as a choice
// going forward (see PostShowCondition's own schema comment).
const POST_SHOW_CONDITION_VALUES: readonly PostShowCondition[] = ["NEW", "OK_TO_REUSE", "AGING", "DAMAGED", "DIRTY"];
const POST_SHOW_DISCARD_REASON_VALUES: readonly PostShowDiscardReason[] = [
  "DAMAGED_BEYOND_REPAIR",
  "CLIENT_APPROVED_DISPOSAL",
  "AGED_OUT",
];

// Post-show disposition is only ever recorded once an order has been
// delivered -- recordPostShowDisposition itself enforces that gate (along
// with the note/discard-reason/approver/photo relationships); re-callable,
// so a Graphics staffer correcting a mis-recorded condition doesn't need
// this to be a one-shot action.
//
// Notifying the Graphics department on a Damaged condition, and sales on
// an Aging one, happen automatically here -- distinct from notifying the
// CLIENT about damage, which stays its own separate, deliberate action
// (notifyClientOfDamageAction below) per this feature's own "notify
// Graphics, which in turn gives them the ability to notify the client"
// design.
//
// Returns an ActionResult rather than throwing its validation errors --
// rendered through ActionForm, so "upload a photo first" / "a note is
// required" actually reach the user in production instead of Next's
// redacted error boundary (see src/lib/user-error.ts).
export async function recordPostShowDispositionAction(
  artworkOrderId: string,
  _prevState: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return catchUserError(() => recordPostShowDispositionFromForm(artworkOrderId, formData));
}

async function recordPostShowDispositionFromForm(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const rawStatus = String(formData.get("postShowStatus") ?? "").trim();
  const rawCondition = String(formData.get("postShowCondition") ?? "").trim();
  const rawDiscardReason = String(formData.get("postShowDiscardReason") ?? "").trim();
  const note = String(formData.get("postShowConditionNote") ?? "").trim();
  const approvedBy = String(formData.get("postShowDisposalApprovedBy") ?? "").trim();
  if (!POST_SHOW_STATUS_VALUES.includes(rawStatus as PostShowStatus)) {
    throw new UserError("Select a post-show status.");
  }
  const condition = POST_SHOW_CONDITION_VALUES.includes(rawCondition as PostShowCondition)
    ? (rawCondition as PostShowCondition)
    : null;

  const { artworkOrder } = await recordPostShowDisposition(
    artworkOrderId,
    {
      postShowStatus: rawStatus as PostShowStatus,
      postShowCondition: condition,
      postShowConditionNote: note || null,
      postShowDiscardReason: POST_SHOW_DISCARD_REASON_VALUES.includes(rawDiscardReason as PostShowDiscardReason)
        ? (rawDiscardReason as PostShowDiscardReason)
        : null,
      postShowDisposalApprovedBy: approvedBy || null,
    },
    actor,
  );

  if (condition === "DAMAGED") {
    await notifyGraphicsOfDamagedAsset(artworkOrderId, artworkOrder.jobCode, note);
  } else if (condition === "AGING" && artworkOrder.opportunityId) {
    await notifySalesOfAgingAsset(artworkOrder.opportunityId, artworkOrder.jobCode, note);
  }

  revalidatePath(`/artwork/${artworkOrderId}`);
}

// Deliberate, staff-triggered follow-up -- only reachable once the
// current condition is actually Damaged, so this can't fire on a piece
// nothing was recorded about.
export async function notifyClientOfDamageAction(artworkOrderId: string) {
  const actor = await expoActor(artworkOrderId);
  const order = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  if (order.postShowCondition !== "DAMAGED") {
    throw new Error("This piece isn't currently recorded as Damaged.");
  }
  const clientEmail = await latestInviteEmail(artworkOrderId, "CLIENT");
  if (!clientEmail) throw new Error("No client contact on file to notify.");
  await notifyClientOfDamagedAsset(artworkOrderId, clientEmail, order.postShowConditionNote ?? "");
  // A same-status audit event, same pattern as every other post-show
  // action -- the Post-Show dashboard's own "damaged, awaiting client
  // notice" bucket is exactly "DAMAGED with no NOTIFIED_CLIENT_OF_DAMAGE
  // event yet," so this is what actually moves a piece out of that list.
  await transitionArtworkOrder(artworkOrderId, order.status, "NOTIFIED_CLIENT_OF_DAMAGE", actor);
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function recordAgingDecisionAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const decision = String(formData.get("decision") ?? "").trim();
  if (decision !== "KEEP_IN_CIRCULATION" && decision !== "MARK_FOR_REPLACEMENT") {
    throw new Error("Unknown aging decision.");
  }
  const note = String(formData.get("note") ?? "").trim() || null;
  await recordAgingDecision(artworkOrderId, decision, actor, note);
  revalidatePath(`/artwork/${artworkOrderId}`);
}

// Finalizes an already-uploaded post-show reference photo -- the file's
// bytes already landed in Blob storage via post-show-photo-upload-token/
// route.ts by the time this runs; this just records the ArtworkFile row.
export async function finalizePostShowPhotoUploadAction(
  artworkOrderId: string,
  data: { storageKey: string; filename: string; mimeType: string; sizeBytes: number; round: number },
) {
  const user = await requireArtworkOrderAccess(artworkOrderId);
  await finalizeArtworkUpload(artworkOrderId, {
    storageKey: data.storageKey,
    kind: "POST_SHOW_CONDITION_PHOTO",
    round: data.round,
    originalFilename: data.filename,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    uploadedByType: "EXPO",
    uploadedByUserId: user.id,
  });
  revalidatePath(`/artwork/${artworkOrderId}`);
}

export async function createAnnotationAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const artworkFileId = String(formData.get("artworkFileId") ?? "").trim();
  if (!artworkFileId) throw new Error("Missing artworkFileId.");
  // Cross-resource check: an artworkFileId submitted from the form must
  // actually belong to THIS order -- same class of check as the
  // annotate page's own fileId verification.
  const file = await db.artworkFile.findUniqueOrThrow({ where: { id: artworkFileId } });
  if (file.artworkOrderId !== artworkOrderId) throw new Error("This file doesn't belong to this order.");
  await createAnnotation(
    artworkFileId,
    { xPct: Number(formData.get("xPct")), yPct: Number(formData.get("yPct")), note: String(formData.get("note") ?? "") },
    actor,
  );
  revalidatePath(`/artwork/${artworkOrderId}/annotate`);
}

export async function resolveAnnotationAction(artworkOrderId: string, formData: FormData) {
  const actor = await expoActor(artworkOrderId);
  const annotationId = String(formData.get("annotationId") ?? "").trim();
  if (!annotationId) throw new Error("Missing annotationId.");
  // Cross-resource check: an annotationId submitted from the form must
  // actually belong to a file on THIS order.
  const annotation = await db.artworkAnnotation.findUniqueOrThrow({
    where: { id: annotationId },
    include: { artworkFile: { select: { artworkOrderId: true } } },
  });
  if (annotation.artworkFile.artworkOrderId !== artworkOrderId) {
    throw new Error("This pin doesn't belong to this order.");
  }
  await resolveAnnotation(annotationId, actor.userId!);
  revalidatePath(`/artwork/${artworkOrderId}/annotate`);
}
