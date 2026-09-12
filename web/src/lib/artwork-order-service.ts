// Artwork approval pipeline: state machine + audit log. See
// data/Graphics-approval-docs/forgeos-artwork-pipeline-spec.md for the full
// spec (19-state lifecycle, vendor-anonymity constraint, 2-round proof-
// revision cap with auto-escalation) and prisma/schema.prisma's ArtworkOrder
// block for why this deliberately does NOT follow changeOpportunityStage's
// permissive any-stage-to-any-stage pattern -- the client must never be able
// to reach a state that would expose a proof before Expo clears it, so
// transitions here are validated against a real table and every one records
// who acted.
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { ArtworkOrderStatus, type ArtworkActorType } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

export const MAX_REVISION_ROUNDS = 2;

// Mirrors the exact edges in the spec's Section 2 state diagram, including
// both loop-backs (Rejected -> OrderDrafted, Escalated -> ProofInProgress).
// A status with no legal outgoing edge (DeliveredAtShow) maps to [].
export const ARTWORK_TRANSITIONS: Record<ArtworkOrderStatus, ArtworkOrderStatus[]> = {
  INVITED: ["ORDER_DRAFTED"],
  ORDER_DRAFTED: ["SUBMITTED"],
  SUBMITTED: ["UNDER_ART_REVIEW"],
  UNDER_ART_REVIEW: ["REJECTED", "ACCEPTED"],
  REJECTED: ["ORDER_DRAFTED"],
  ACCEPTED: ["VENDOR_ASSIGNED"],
  VENDOR_ASSIGNED: ["PROOF_IN_PROGRESS"],
  PROOF_IN_PROGRESS: ["PROOF_SUBMITTED"],
  PROOF_SUBMITTED: ["EXPO_PROOF_CHECK"],
  EXPO_PROOF_CHECK: ["PROOF_REVISION_REQUESTED", "PROOF_UNDER_REVIEW"],
  PROOF_REVISION_REQUESTED: ["PROOF_IN_PROGRESS", "ESCALATED"],
  ESCALATED: ["PROOF_IN_PROGRESS"],
  PROOF_UNDER_REVIEW: ["PROOF_REVISION_REQUESTED", "PROOF_APPROVED"],
  PROOF_APPROVED: ["PRODUCTION_GO_AHEAD"],
  PRODUCTION_GO_AHEAD: ["IN_PRODUCTION"],
  IN_PRODUCTION: ["PACKAGED_READY"],
  PACKAGED_READY: ["SHIPPED_TO_SHOW"],
  SHIPPED_TO_SHOW: ["DELIVERED_AT_SHOW"],
  DELIVERED_AT_SHOW: [],
};

export function assertValidTransition(from: ArtworkOrderStatus, to: ArtworkOrderStatus): void {
  if (from === to) return; // a same-state call is always an annotation-only event (e.g. a negotiation note), never a real transition
  const legal = ARTWORK_TRANSITIONS[from] ?? [];
  if (!legal.includes(to)) {
    throw new Error(`Illegal artwork order transition: ${from} -> ${to}`);
  }
}

const SLA_HOURS_NORMAL = 24;
const SLA_HOURS_FINAL_WEEK = 4;
const FINAL_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// 24h normally, tightening to 4h once the show's eventStartDate is within
// its final week -- per the spec's resolved SLA decision. No eventStartDate
// on the opportunity yet (common during early onboarding) falls back to the
// normal window rather than guessing urgency.
export function computeSlaDueAt(now: Date, eventStartDate: Date | null): Date {
  const hours =
    eventStartDate && eventStartDate.getTime() - now.getTime() <= FINAL_WEEK_MS ? SLA_HOURS_FINAL_WEEK : SLA_HOURS_NORMAL;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

function generateJobCode(): string {
  // 4 bytes = 8 hex chars, only ever shown to the vendor -- see
  // ArtworkOrder.jobCode's schema comment. Not derived from anything
  // client-identifying. Collisions are astronomically unlikely; createArtworkOrder
  // retries on the rare unique-constraint conflict rather than pre-checking.
  return `EXPO-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function createArtworkOrder(
  opportunityId: string,
  data: { sizeTierId?: string | null; material?: string | null; qty?: number } = {},
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.artworkOrder.create({
        data: {
          opportunityId,
          jobCode: generateJobCode(),
          sizeTierId: data.sizeTierId ?? null,
          material: data.material ?? null,
          qty: data.qty ?? 1,
        },
      });
    } catch (err) {
      const isUniqueConflict = typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
      if (!isUniqueConflict || attempt === 4) throw err;
    }
  }
  throw new Error("Failed to generate a unique artwork order job code after 5 attempts.");
}

export interface ArtworkActor {
  type: ArtworkActorType;
  userId?: string | null;
  email?: string | null;
}

export interface TransitionOptions {
  note?: string | null;
  detail?: Prisma.InputJsonValue;
  restrictedToInternal?: boolean;
}

// The single entry point for every status change AND every status-preserving
// annotation (e.g. a custom-size negotiation round) in this pipeline --
// mirrors LineItemAuditLog's "one shared writer" pattern. No other code path
// should create an ArtworkOrderEvent row directly.
export async function transitionArtworkOrder(
  artworkOrderId: string,
  toStatus: ArtworkOrderStatus,
  action: string,
  actor: ArtworkActor,
  opts: TransitionOptions = {},
) {
  const current = await db.artworkOrder.findUniqueOrThrow({
    where: { id: artworkOrderId },
    include: { opportunity: { select: { eventStartDate: true } } },
  });

  let effectiveToStatus: ArtworkOrderStatus = toStatus;
  let revisionRound = current.revisionRound;
  let escalated = false;

  if (toStatus === "PROOF_REVISION_REQUESTED" && current.status !== "PROOF_REVISION_REQUESTED") {
    assertValidTransition(current.status, "PROOF_REVISION_REQUESTED");
    const nextRound = current.revisionRound + 1;
    if (nextRound > MAX_REVISION_ROUNDS) {
      // A 3rd required round never actually happens -- it auto-escalates
      // instead. This composes two consecutive, individually-legal diagram
      // edges (-> ProofRevisionRequested -> Escalated) into one DB write,
      // so the persisted record only ever shows the real end state.
      assertValidTransition("PROOF_REVISION_REQUESTED", "ESCALATED");
      effectiveToStatus = "ESCALATED";
      escalated = true;
      // revisionRound deliberately stays at the cap (2), not incremented to
      // 3 -- the 3rd round was requested but never actually occurred.
    } else {
      effectiveToStatus = "PROOF_REVISION_REQUESTED";
      revisionRound = nextRound;
    }
  } else {
    assertValidTransition(current.status, toStatus);
  }

  let restrictedToInternal = opts.restrictedToInternal ?? false;
  const detail = opts.detail;

  if (current.status === "ESCALATED" && effectiveToStatus === "PROOF_IN_PROGRESS") {
    // Non-negotiable per the spec's resolved decision: an escalation cannot
    // be resolved without a structured resolution note, and that note is
    // Expo-internal only regardless of what the caller passed.
    if (!opts.detail) {
      throw new Error("Resolving an escalation requires a resolution note (opts.detail).");
    }
    restrictedToInternal = true;
    revisionRound = 0;
  }

  let slaDueAt = current.slaDueAt;
  if (effectiveToStatus === "EXPO_PROOF_CHECK") {
    slaDueAt = computeSlaDueAt(new Date(), current.opportunity.eventStartDate);
  }

  const [, event] = await db.$transaction([
    db.artworkOrder.update({
      where: { id: artworkOrderId },
      data: { status: effectiveToStatus, revisionRound, slaDueAt },
    }),
    db.artworkOrderEvent.create({
      data: {
        artworkOrderId,
        fromStatus: current.status,
        toStatus: effectiveToStatus,
        action,
        note: opts.note ?? null,
        detail: detail ?? (escalated ? { escalatedFromRequestedRound: MAX_REVISION_ROUNDS + 1 } : undefined),
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorEmail: actor.email ?? null,
        restrictedToInternal,
      },
    }),
  ]);

  return { artworkOrder: await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } }), event, escalated };
}

// The domain-action functions below wrap transitionArtworkOrder for the
// handful of actions with real extra logic beyond a single status change
// (a data field to set, a fee to compute, or a SYSTEM step that always
// immediately follows). Every OTHER transition in the diagram (reject,
// confirm-proof-match, issue go-ahead, mark delivered, client sign-off, the
// vendor's sequential production-status marks, ...) is simple enough that
// callers (Pieces 3-5's Server Actions) call transitionArtworkOrder
// directly rather than through a one-line wrapper for each.

// Custom-size quote flow's hard gate (spec Section 5): a client cannot
// submit until Expo has issued a quote AND the client has accepted it.
export async function setCustomSizeQuote(artworkOrderId: string, amount: number, actor: ArtworkActor) {
  await db.artworkOrder.update({ where: { id: artworkOrderId }, data: { customQuoteAmount: amount } });
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  return transitionArtworkOrder(artworkOrderId, current.status, "CUSTOM_QUOTE_ISSUED", actor, {
    detail: { amount } as Prisma.InputJsonValue,
  });
}

export async function acceptCustomSizeQuote(artworkOrderId: string, actor: ArtworkActor) {
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  if (current.customQuoteAmount == null) {
    throw new Error("No custom-size quote has been issued yet.");
  }
  await db.artworkOrder.update({ where: { id: artworkOrderId }, data: { customQuoteAcceptedAt: new Date() } });
  return transitionArtworkOrder(artworkOrderId, current.status, "CUSTOM_QUOTE_ACCEPTED", actor);
}

// Enforces the same hard gate at the actual submission point (not just at
// quote-accept time) -- a client could otherwise request a custom size,
// never accept the quote, and still submit if this weren't checked here
// too. Chains straight through UNDER_ART_REVIEW's auto-routing (spec:
// "Auto-notify art dept + account rep"), since nothing about that step is
// a real decision point.
export async function submitArtworkOrder(artworkOrderId: string, actor: ArtworkActor) {
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  if (current.customSizeRequested && !current.customQuoteAcceptedAt) {
    throw new Error("A custom-size quote must be issued and accepted before this order can be submitted.");
  }
  await transitionArtworkOrder(artworkOrderId, "SUBMITTED", "SUBMIT", actor);
  return transitionArtworkOrder(artworkOrderId, "UNDER_ART_REVIEW", "AUTO_ROUTE", { type: "SYSTEM" });
}

// Expo-produced-art fee (spec Section 5): computed from the size tier's
// configured fee at the moment of acceptance, not at order-draft time --
// the size tier's fee could change before then. Only ever set when the
// client actually opted in; otherwise expoProducedFee stays null (an
// honest "not applicable," not a computed zero).
export async function acceptArtworkOrder(artworkOrderId: string, actor: ArtworkActor) {
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId }, include: { sizeTier: true } });
  if (current.wantsExpoProducedArt && current.sizeTier) {
    await db.artworkOrder.update({
      where: { id: artworkOrderId },
      data: { expoProducedFee: current.sizeTier.expoProducedFee },
    });
  }
  return transitionArtworkOrder(artworkOrderId, "ACCEPTED", "APPROVE", actor);
}

// Chains straight through "vendor notified, begins production" (spec:
// this is presented as an immediate consequence of assignment, not a
// separate decision the vendor makes) -- the vendor's own first real
// action is uploading a proof, not accepting the job.
export async function assignVendor(artworkOrderId: string, vendorId: string, actor: ArtworkActor) {
  await db.artworkOrder.update({ where: { id: artworkOrderId }, data: { vendorId } });
  await transitionArtworkOrder(artworkOrderId, "VENDOR_ASSIGNED", "ASSIGN_VENDOR", actor);
  return transitionArtworkOrder(artworkOrderId, "PROOF_IN_PROGRESS", "VENDOR_NOTIFIED", { type: "SYSTEM" });
}

// Chains straight through ExpoProofCheck's auto-queueing, mirroring
// submitArtworkOrder's chain through UnderArtReview -- Expo's manual check
// happens as its own separate action (confirmProofMatch/requestRevision
// below), triggered from the review-queue UI once the SLA clock (set here
// via transitionArtworkOrder's own EXPO_PROOF_CHECK handling) starts.
export async function uploadProof(artworkOrderId: string, actor: ArtworkActor) {
  await transitionArtworkOrder(artworkOrderId, "PROOF_SUBMITTED", "UPLOAD_PROOF", actor);
  return transitionArtworkOrder(artworkOrderId, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });
}

// A guarded field update, not a status transition -- the order form's
// fields (size, material, qty, the Expo-produced-art opt-in) are only ever
// safe to edit while still in the client's hands (drafting, or resubmitting
// after a rejection). Once submitted, these fields describe what Expo/the
// vendor are already acting on; letting them change silently underneath a
// review in progress would be a real correctness bug, not just a UX nicety.
export async function updateArtworkOrderDraft(
  artworkOrderId: string,
  data: {
    sizeTierId?: string | null;
    customSizeRequested?: boolean;
    customWidth?: number | null;
    customHeight?: number | null;
    material?: string | null;
    qty?: number;
    wantsExpoProducedArt?: boolean;
  },
) {
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  if (current.status !== "ORDER_DRAFTED" && current.status !== "REJECTED") {
    throw new Error("Order details can only be edited while drafting or resubmitting.");
  }
  return db.artworkOrder.update({ where: { id: artworkOrderId }, data });
}
