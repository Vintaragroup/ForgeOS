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
import { assignSingleVendor, defaultProductionStatus } from "@/lib/artwork-routing";
import { reprintNoteRequired } from "@/lib/artwork-reprint";
import { UserError } from "@/lib/user-error";
import {
  ArtworkOrderStatus,
  type ArtworkActorType,
  type ArtworkOrderType,
  type ArtworkReprintReason,
  type ExistingGraphicsStatus,
  type PostShowStatus,
  type PostShowCondition,
  type PostShowDiscardReason,
} from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

export const MAX_REVISION_ROUNDS = 2;

// A Show represents ExpoCCI already holding the contract for that whole
// event -- creating one IS the "we won this" signal, independent of where
// any individual exhibitor's own Opportunity happens to sit in the
// separate sales/estimating pipeline (New/Contacted/Qualified/Estimating/
// Won/Lost). So artwork onboarding opens for ANY opportunity linked to a
// show, at any stage -- a standalone opportunity (no show, sold as its own
// one-off deal) still needs its own stage to actually reach WON, since
// there's no show-level "already secured" signal to lean on instead.
// Single source of truth for this rule -- every surface that gates
// artwork onboarding (the Opportunity page's own Artwork section, the Show
// hub's per-client invite, the Graphics dashboard's quick-start picker)
// reads from here rather than re-deriving it, so they can't drift apart.
export function canStartArtworkOnboarding(opportunity: { stage: string; showId: string | null }): boolean {
  return opportunity.stage === "WON" || opportunity.showId != null;
}

// Mirrors the exact edges in the spec's Section 2 state diagram, including
// both loop-backs (Rejected -> OrderDrafted, Escalated -> ProofInProgress).
// A status with no legal outgoing edge (DeliveredAtShow) maps to [].
//
// Graphics Production Hub additions: RECEIVED_FROM_VENDOR/INSPECTED are
// optional receiving/QC waypoints -- IN_PRODUCTION can still go straight to
// PACKAGED_READY for a piece that skips them (matches most of the real
// historical data), or step through either/both first.
// REPRINT_REQUESTED loops back to IN_PRODUCTION, same shape as
// PROOF_REVISION_REQUESTED's own loop earlier in the pipeline.
// CANCELLED is deliberately NOT listed as an edge on every entry below --
// it's reachable from any pre-DELIVERED_AT_SHOW state via the dedicated
// cancelArtworkOrder() below, mirroring how transitionArtworkOrder already
// special-cases escalation/SLA logic rather than encoding every rule as a
// transition-table edge.
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
  IN_PRODUCTION: ["RECEIVED_FROM_VENDOR", "INSPECTED", "PACKAGED_READY", "REPRINT_REQUESTED"],
  RECEIVED_FROM_VENDOR: ["INSPECTED", "PACKAGED_READY", "REPRINT_REQUESTED"],
  INSPECTED: ["PACKAGED_READY", "REPRINT_REQUESTED"],
  REPRINT_REQUESTED: ["IN_PRODUCTION"],
  PACKAGED_READY: ["SHIPPED_TO_SHOW"],
  SHIPPED_TO_SHOW: ["DELIVERED_AT_SHOW"],
  DELIVERED_AT_SHOW: [],
  CANCELLED: [],
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

// owner is a discriminated union rather than two optional params -- the
// type system itself makes "neither" or "both" of opportunityId/showId
// impossible to pass, not just a runtime check. Every pre-existing
// client-onboarding caller passes { opportunityId }; the Graphics
// Production Hub's own Hub/hanging-sign creation path (no client, no
// opportunity) passes { showId } instead -- see ArtworkOrder.showId's
// schema comment.
export async function createArtworkOrder(
  owner: { opportunityId: string } | { showId: string },
  data: { sizeTierId?: string | null; material?: string | null; qty?: number } = {},
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.artworkOrder.create({
        data: {
          ...("opportunityId" in owner ? { opportunityId: owner.opportunityId } : { showId: owner.showId }),
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
  // opportunity is null for a Show-owned Hub/hanging-sign piece (see
  // ArtworkOrder.showId's schema comment) -- eventStartDate then falls
  // back to the Show's own, matching computeSlaDueAt's existing
  // no-date-yet fallback either way.
  const current = await db.artworkOrder.findUniqueOrThrow({
    where: { id: artworkOrderId },
    include: {
      opportunity: { select: { eventStartDate: true } },
      show: { select: { eventStartDate: true } },
    },
  });
  const eventStartDate = current.opportunity?.eventStartDate ?? current.show?.eventStartDate ?? null;

  let effectiveToStatus: ArtworkOrderStatus = toStatus;
  let revisionRound = current.revisionRound;
  let escalated = false;

  if (toStatus === "CANCELLED") {
    // Bypasses ARTWORK_TRANSITIONS entirely -- CANCELLED is reachable from
    // any pre-DELIVERED_AT_SHOW state, which isn't worth encoding as an
    // edge on every single entry in that table (see its own comment).
    if (current.status === "DELIVERED_AT_SHOW" || current.status === "CANCELLED") {
      throw new Error(`Cannot cancel an artwork order in status ${current.status}.`);
    }
  } else if (toStatus === "PROOF_REVISION_REQUESTED" && current.status !== "PROOF_REVISION_REQUESTED") {
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
    slaDueAt = computeSlaDueAt(new Date(), eventStartDate);
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

export interface RolloverSource {
  id: string;
  material: string | null;
  qty: number;
  graphicCode: string | null;
  finishingDetails: string | null;
  customWidth: Prisma.Decimal | null;
  customHeight: Prisma.Decimal | null;
  vendorId: string | null;
  designerId: string | null;
  sizeTierId: string | null;
}

// Rolls one prior-show piece forward into a new show occurrence -- the
// Graphics team's own annual pattern (returning clients reuse last year's
// artwork unless something changed), and the whole reason
// existingGraphicsStatus exists as a field. See shows/actions.ts's
// rolloverShowAction, the only caller. Reuses generateJobCode() and the
// same create-with-retry-on-collision shape createArtworkOrder already
// uses (this function lives in the same file for exactly that reason,
// even though it can't call createArtworkOrder directly -- that function's
// own `data` param doesn't accept the extra fields a rollover needs to
// copy). Then logs a same-status INVITED -> INVITED transition via
// transitionArtworkOrder, matching setProductionDetail's own pattern, so
// the rollover shows up in the new order's own audit trail instead of
// looking like an unexplained pre-filled row.
export async function rolloverArtworkOrder(
  source: RolloverSource,
  target: { opportunityId: string } | { showId: string },
  actor: ArtworkActor,
) {
  let created: Prisma.ArtworkOrderGetPayload<Record<string, never>> | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      created = await db.artworkOrder.create({
        data: {
          ...("opportunityId" in target ? { opportunityId: target.opportunityId } : { showId: target.showId }),
          jobCode: generateJobCode(),
          material: source.material,
          qty: source.qty,
          graphicCode: source.graphicCode,
          finishingDetails: source.finishingDetails,
          customWidth: source.customWidth,
          customHeight: source.customHeight,
          vendorId: source.vendorId,
          designerId: source.designerId,
          sizeTierId: source.sizeTierId,
          // The whole point of rollover -- last year's piece is being
          // reused, not freshly designed, unless Graphics staff changes
          // this after the fact.
          existingGraphicsStatus: "EXISTING",
          rolledOverFromId: source.id,
        },
      });
      break;
    } catch (err) {
      const isUniqueConflict = typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
      if (!isUniqueConflict || attempt === 4) throw err;
    }
  }
  if (!created) throw new Error("Failed to generate a unique artwork order job code after 5 attempts.");

  // Carry last year's routing forward. Rollover predates the routing model
  // and copied vendorId alone, which left the new piece pointing at a shop
  // with no routing row to match -- the exact drift assignVendor exists to
  // prevent. Where it was printed is as reusable as its material.
  //
  // Production status is NOT carried: each half starts at its own default.
  // A piece that has not been made yet is not "O.S received" because last
  // year's was.
  const sourceRoutings = await db.artworkOrderRouting.findMany({
    where: { artworkOrderId: source.id },
    select: { kind: true, vendorId: true, officeCode: true },
  });
  for (const routing of sourceRoutings) {
    await db.artworkOrderRouting.create({
      data: {
        artworkOrderId: created.id,
        kind: routing.kind,
        vendorId: routing.vendorId,
        officeCode: routing.officeCode,
        productionStatus: defaultProductionStatus(routing.kind),
      },
    });
  }

  await transitionArtworkOrder(created.id, "INVITED", "ROLLED_OVER_FROM_PRIOR_SHOW", actor, {
    detail: { fromArtworkOrderId: source.id } as Prisma.InputJsonValue,
  });

  return created;
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

// Expo setting/correcting the order's real production spec -- reuses
// customWidth/customHeight rather than a parallel "final" pair (one
// canonical spec; every change either side makes is already logged via
// this same same-status transitionArtworkOrder call, matching
// setCustomSizeQuote's own pattern above). Each field is independently
// optional: Expo can set just a bleed without re-typing dimensions
// already trusted from the uploaded file, or vice versa. `undefined`
// means "leave unchanged"; `null` means "clear it."
export async function setProductionSpec(
  artworkOrderId: string,
  spec: { widthIn?: number | null; heightIn?: number | null; bleedIn?: number | null },
  actor: ArtworkActor,
) {
  const data: Prisma.ArtworkOrderUpdateInput = {};
  const detail: Record<string, number | null> = {};
  if (spec.widthIn !== undefined) {
    data.customWidth = spec.widthIn;
    detail.widthIn = spec.widthIn;
  }
  if (spec.heightIn !== undefined) {
    data.customHeight = spec.heightIn;
    detail.heightIn = spec.heightIn;
  }
  if (spec.bleedIn !== undefined) {
    data.bleedIn = spec.bleedIn;
    detail.bleedIn = spec.bleedIn;
  }
  await db.artworkOrder.update({ where: { id: artworkOrderId }, data });
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  return transitionArtworkOrder(artworkOrderId, current.status, "SET_PRODUCTION_SPEC", actor, {
    detail: detail as Prisma.InputJsonValue,
  });
}

// Graphics Production Hub: the per-piece production detail Expo/Graphics
// staff fill in and correct during production -- material/qty were
// previously only editable client-side via updateArtworkOrderDraft
// (ORDER_DRAFTED/REJECTED only), so there was no way to correct either
// once production actually started. Same shape as setProductionSpec
// above: a guarded field update, logged via a same-status
// transitionArtworkOrder call rather than a real status change.
// `undefined` means "leave unchanged"; `null` means "clear it" (except
// `qty`, which has no meaningful null).
export async function setProductionDetail(
  artworkOrderId: string,
  detail: {
    material?: string | null;
    qty?: number;
    graphicCode?: string | null;
    finishingDetails?: string | null;
    artDueDate?: Date | null;
    inHandDate?: Date | null;
    orderType?: ArtworkOrderType | null;
    existingGraphicsStatus?: ExistingGraphicsStatus | null;
    verifiedSizes?: boolean;
    designerId?: string | null;
  },
  actor: ArtworkActor,
) {
  const data: Prisma.ArtworkOrderUpdateInput = {};
  const eventDetail: Record<string, unknown> = {};
  for (const key of [
    "material",
    "qty",
    "graphicCode",
    "finishingDetails",
    "artDueDate",
    "inHandDate",
    "orderType",
    "existingGraphicsStatus",
    "verifiedSizes",
    "designerId",
  ] as const) {
    if (detail[key] === undefined) continue;
    (data as Record<string, unknown>)[key] = detail[key];
    eventDetail[key] = detail[key] instanceof Date ? detail[key].toISOString() : detail[key];
  }
  await db.artworkOrder.update({ where: { id: artworkOrderId }, data });
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  return transitionArtworkOrder(artworkOrderId, current.status, "SET_PRODUCTION_DETAIL", actor, {
    detail: eventDetail as Prisma.InputJsonValue,
  });
}

// Graphics Production Hub: what physically happened to a piece after the
// show. Only meaningful once delivered -- postShowStatus/Condition are
// facts recorded once, not more ArtworkOrderStatus states (see those
// enums' own schema comments), so this is a same-status transition, same
// as setProductionSpec/setProductionDetail above, not a real status
// change. Re-callable (a Graphics staffer correcting a mis-recorded
// condition doesn't need a new "un-received" state to exist).
export interface PostShowDisposition {
  postShowStatus: PostShowStatus;
  postShowCondition: PostShowCondition | null;
  // Effectively required (enforced below, not just a UI nicety) whenever
  // condition is DAMAGED/AGING or a discard reason is set at all -- "why"
  // always needs a real explanation, not just the category.
  postShowConditionNote?: string | null;
  // Only valid alongside postShowStatus DISCARDED -- see
  // PostShowDiscardReason's own schema comment for why this is a separate
  // field from condition.
  postShowDiscardReason?: PostShowDiscardReason | null;
  // Required alongside discardReason CLIENT_APPROVED_DISPOSAL specifically
  // -- a name/contact, turning "the client said we could throw it away"
  // into an actual attributed record instead of an opaque label.
  postShowDisposalApprovedBy?: string | null;
}

// Re-callable (a Graphics staffer correcting a mis-recorded disposition
// doesn't need a new "un-received" state to exist). Validates the
// condition/discard-reason/approver/photo relationships explicitly rather
// than trusting the UI to only ever submit a consistent combination --
// this is the sole writer for post-show data, same posture as
// transitionArtworkOrder is for status.
export async function recordPostShowDisposition(
  artworkOrderId: string,
  disposition: PostShowDisposition,
  actor: ArtworkActor,
) {
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  if (current.status !== "DELIVERED_AT_SHOW") {
    throw new UserError("Post-show disposition can only be recorded once an order has been delivered at the show.");
  }

  const hasDiscardReason = disposition.postShowDiscardReason != null;
  if (disposition.postShowStatus === "DISCARDED" && !hasDiscardReason) {
    throw new UserError("A discard reason is required when marking a piece Discarded.");
  }
  if (disposition.postShowStatus !== "DISCARDED" && hasDiscardReason) {
    throw new UserError("A discard reason only applies when the disposition is Discarded.");
  }

  const isClientApproved = disposition.postShowDiscardReason === "CLIENT_APPROVED_DISPOSAL";
  if (isClientApproved && !disposition.postShowDisposalApprovedBy?.trim()) {
    throw new UserError("Record who approved the disposal when the reason is client-approved.");
  }
  if (!isClientApproved && disposition.postShowDisposalApprovedBy) {
    throw new UserError("An approver name only applies to a client-approved disposal.");
  }

  const needsNote =
    disposition.postShowCondition === "DAMAGED" || disposition.postShowCondition === "AGING" || hasDiscardReason;
  if (needsNote && !disposition.postShowConditionNote?.trim()) {
    throw new UserError("A note is required for a damaged, aging, or discarded piece -- explain what's going on.");
  }

  const needsPhoto = disposition.postShowCondition === "DAMAGED" || disposition.postShowDiscardReason === "DAMAGED_BEYOND_REPAIR";
  if (needsPhoto) {
    const photoCount = await db.artworkFile.count({
      where: { artworkOrderId, kind: "POST_SHOW_CONDITION_PHOTO", deletedAt: null },
    });
    if (photoCount === 0) {
      throw new UserError("Upload at least one reference photo before recording a damaged condition.");
    }
  }

  await db.artworkOrder.update({
    where: { id: artworkOrderId },
    data: {
      postShowStatus: disposition.postShowStatus,
      postShowCondition: disposition.postShowCondition,
      postShowConditionNote: disposition.postShowConditionNote?.trim() || null,
      postShowDiscardReason: disposition.postShowDiscardReason ?? null,
      postShowDisposalApprovedBy: disposition.postShowDisposalApprovedBy?.trim() || null,
      postShowRecordedAt: new Date(),
      postShowRecordedByUserId: actor.userId ?? null,
    },
  });
  return transitionArtworkOrder(artworkOrderId, current.status, "RECORD_POST_SHOW_DISPOSITION", actor, {
    detail: disposition as unknown as Prisma.InputJsonValue,
  });
}

// A same-status audit event only -- no ArtworkOrder field changes. Keeping
// AGING itself and its eventual resolution as two separate, deliberate
// steps: this just records that someone reviewed an AGING-flagged piece
// and made a call. "Keep in circulation" needs nothing further. "Mark for
// replacement" doesn't itself discard the old piece or create the new one
// -- those stay their own explicit actions (recordPostShowDisposition with
// discardReason AGED_OUT once the old piece is actually retired; the
// ordinary Create Order flow, pre-filled to this client, for the new one)
// so this function isn't guessing at a business decision (discard now?
// keep as backup until the replacement ships?) nobody's actually made yet.
export async function recordAgingDecision(
  artworkOrderId: string,
  decision: "KEEP_IN_CIRCULATION" | "MARK_FOR_REPLACEMENT",
  actor: ArtworkActor,
  note?: string | null,
) {
  const current = await db.artworkOrder.findUniqueOrThrow({ where: { id: artworkOrderId } });
  if (current.postShowCondition !== "AGING") {
    throw new Error("This piece isn't currently flagged as aging.");
  }
  return transitionArtworkOrder(
    artworkOrderId,
    current.status,
    decision === "KEEP_IN_CIRCULATION" ? "AGING_KEPT_IN_CIRCULATION" : "AGING_MARKED_FOR_REPLACEMENT",
    actor,
    { detail: { note: note ?? null } as Prisma.InputJsonValue },
  );
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
  // Writes the routing set too, so ArtworkOrder.vendorId and
  // ArtworkOrder.routings can't drift while both exist. This path means
  // "the outside shop is X", so it replaces any other VENDOR entry but
  // leaves in-house or AM/PM-coordinated halves alone -- assigning a
  // vendor must not silently delete the fact that Miami is printing part
  // of the same piece.
  await assignSingleVendor(artworkOrderId, vendorId);
  await transitionArtworkOrder(artworkOrderId, "VENDOR_ASSIGNED", "ASSIGN_VENDOR", actor);
  return transitionArtworkOrder(artworkOrderId, "PROOF_IN_PROGRESS", "VENDOR_NOTIFIED", { type: "SYSTEM" });
}

// Sends a piece back to be run again. REPRINT_REQUESTED was a legal
// transition that nothing could actually reach -- no service function, no
// button -- so this is the path to it.
//
// The reason is recorded on the order, not just the event, because it has
// to survive the loop back to IN_PRODUCTION: the status says a reprint is
// happening now, the reason says why it ever did. The yearly executive
// reprint report is built from the latter.
export async function requestReprint(
  artworkOrderId: string,
  input: { reason: ArtworkReprintReason; note?: string | null },
  actor: ArtworkActor,
) {
  const order = await db.artworkOrder.findFirst({
    where: { id: artworkOrderId, deletedAt: null },
    select: { id: true, orderType: true },
  });
  if (!order) throw new UserError("That piece no longer exists.");

  // Her column holds this value, but it does not describe a reprint -- it
  // means the row is additional billable work. Recording it here would put
  // a piece that was never reprinted into the reprint loop.
  if (input.reason === "NEW_ORDER_UPSELL") {
    throw new UserError("An upsell isn't a reprint -- raise it as a new piece instead.");
  }

  const note = input.note?.trim() || null;
  if (reprintNoteRequired(input.reason) && !note) {
    throw new UserError("Say what happened -- \"Other\" on its own doesn't explain anything later.");
  }

  await db.artworkOrder.update({
    where: { id: artworkOrderId },
    data: { reprintReason: input.reason, reprintNote: note },
  });
  return transitionArtworkOrder(artworkOrderId, "REPRINT_REQUESTED", "REQUEST_REPRINT", actor, {
    note,
    detail: { reprintReason: input.reason },
  });
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

// Thin wrapper -- the real "reachable from any pre-DELIVERED_AT_SHOW
// state" logic lives inside transitionArtworkOrder's own CANCELLED
// special-case above, keeping it the sole writer of ArtworkOrderEvent rows
// rather than duplicating that transaction here.
export async function cancelArtworkOrder(artworkOrderId: string, actor: ArtworkActor, note?: string | null) {
  return transitionArtworkOrder(artworkOrderId, "CANCELLED", "CANCEL", actor, { note: note ?? null });
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
