import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ARTWORK_TRANSITIONS,
  MAX_REVISION_ROUNDS,
  acceptArtworkOrder,
  acceptCustomSizeQuote,
  assertValidTransition,
  assignVendor,
  cancelArtworkOrder,
  canStartArtworkOnboarding,
  computeSlaDueAt,
  createArtworkOrder,
  recordAgingDecision,
  recordPostShowDisposition,
  rolloverArtworkOrder,
  setCustomSizeQuote,
  setProductionDetail,
  setProductionSpec,
  submitArtworkOrder,
  transitionArtworkOrder,
  updateArtworkOrderDraft,
  uploadProof,
  type ArtworkActor,
} from "@/lib/artwork-order-service";

afterEach(async () => {
  await db.artworkOrderEvent.deleteMany();
  await db.artworkPortalInvite.deleteMany();
  await db.artworkFile.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.artworkSizeTier.deleteMany();
  await db.vendor.deleteMany();
  await db.opportunity.deleteMany();
  await db.show.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeArtworkOrder(eventStartDate: Date | null = null) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show", eventStartDate },
  });
  return createArtworkOrder({ opportunityId: opportunity.id });
}

const EXPO_ACTOR = { type: "EXPO" as const, userId: "user-1" };
const CLIENT_ACTOR = { type: "CLIENT" as const, email: "client@example.com" };
const VENDOR_ACTOR = { type: "VENDOR" as const, email: "vendor@example.com" };

describe("canStartArtworkOnboarding", () => {
  it("is eligible once Won, even with no show", () => {
    expect(canStartArtworkOnboarding({ stage: "WON", showId: null })).toBe(true);
  });

  it("is eligible when linked to a show, regardless of pipeline stage", () => {
    for (const stage of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATING", "LOST"]) {
      expect(canStartArtworkOnboarding({ stage, showId: "show-1" })).toBe(true);
    }
  });

  it("is not eligible for a standalone (no show) opportunity short of Won", () => {
    for (const stage of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATING", "LOST"]) {
      expect(canStartArtworkOnboarding({ stage, showId: null })).toBe(false);
    }
  });
});

describe("assertValidTransition", () => {
  it("allows every legal edge in the state diagram", () => {
    for (const [from, tos] of Object.entries(ARTWORK_TRANSITIONS)) {
      for (const to of tos) {
        expect(() => assertValidTransition(from as never, to as never)).not.toThrow();
      }
    }
  });

  it("rejects an illegal edge", () => {
    expect(() => assertValidTransition("INVITED", "PROOF_APPROVED")).toThrow(/Illegal artwork order transition/);
  });

  it("allows a same-state call (annotation-only event)", () => {
    expect(() => assertValidTransition("ORDER_DRAFTED", "ORDER_DRAFTED")).not.toThrow();
  });

  it("rejects skipping ahead even along a plausible-looking path", () => {
    expect(() => assertValidTransition("SUBMITTED", "ACCEPTED")).toThrow();
  });
});

describe("createArtworkOrder", () => {
  it("creates an order in INVITED status with a unique EXPO- job code", async () => {
    const order = await makeArtworkOrder();
    expect(order.status).toBe("INVITED");
    expect(order.jobCode).toMatch(/^EXPO-[0-9A-F]{8}$/);
    expect(order.revisionRound).toBe(0);
  });
});

describe("transitionArtworkOrder", () => {
  it("walks the full happy path from Invited to DeliveredAtShow", async () => {
    const order = await makeArtworkOrder();
    const path: { toStatus: Parameters<typeof transitionArtworkOrder>[1]; action: string; actor: ArtworkActor }[] = [
      { toStatus: "ORDER_DRAFTED", action: "OPEN_PORTAL", actor: CLIENT_ACTOR },
      { toStatus: "SUBMITTED", action: "SUBMIT", actor: CLIENT_ACTOR },
      { toStatus: "UNDER_ART_REVIEW", action: "AUTO_ROUTE", actor: { type: "SYSTEM" } },
      { toStatus: "ACCEPTED", action: "APPROVE", actor: EXPO_ACTOR },
      { toStatus: "VENDOR_ASSIGNED", action: "ASSIGN_VENDOR", actor: EXPO_ACTOR },
      { toStatus: "PROOF_IN_PROGRESS", action: "VENDOR_NOTIFIED", actor: { type: "SYSTEM" } },
      { toStatus: "PROOF_SUBMITTED", action: "UPLOAD_PROOF", actor: VENDOR_ACTOR },
      { toStatus: "EXPO_PROOF_CHECK", action: "QUEUE_FOR_CHECK", actor: { type: "SYSTEM" } },
      { toStatus: "PROOF_UNDER_REVIEW", action: "CONFIRM_MATCH", actor: EXPO_ACTOR },
      { toStatus: "PROOF_APPROVED", action: "CLIENT_SIGN_OFF", actor: CLIENT_ACTOR },
      { toStatus: "PRODUCTION_GO_AHEAD", action: "ISSUE_GO_AHEAD", actor: EXPO_ACTOR },
      { toStatus: "IN_PRODUCTION", action: "SENT_TO_PRODUCTION", actor: VENDOR_ACTOR },
      { toStatus: "PACKAGED_READY", action: "PACKAGED", actor: VENDOR_ACTOR },
      { toStatus: "SHIPPED_TO_SHOW", action: "SHIPPED", actor: VENDOR_ACTOR },
      { toStatus: "DELIVERED_AT_SHOW", action: "DELIVERED", actor: EXPO_ACTOR },
    ];

    let id = order.id;
    for (const step of path) {
      const { artworkOrder } = await transitionArtworkOrder(id, step.toStatus, step.action, step.actor);
      expect(artworkOrder.status).toBe(step.toStatus);
      id = artworkOrder.id;
    }

    const events = await db.artworkOrderEvent.findMany({ where: { artworkOrderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(events).toHaveLength(path.length);
    expect(events[0].fromStatus).toBe("INVITED");
    expect(events.at(-1)?.toStatus).toBe("DELIVERED_AT_SHOW");
  });

  it("rejects an illegal transition and writes no event", async () => {
    const order = await makeArtworkOrder();
    await expect(transitionArtworkOrder(order.id, "PROOF_APPROVED", "SKIP_AHEAD", EXPO_ACTOR)).rejects.toThrow();
    expect(await db.artworkOrderEvent.count({ where: { artworkOrderId: order.id } })).toBe(0);
  });

  it("records the actor on every event, including external client/vendor actors with no userId", async () => {
    const order = await makeArtworkOrder();
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    const event = await db.artworkOrderEvent.findFirstOrThrow({ where: { artworkOrderId: order.id } });
    expect(event.actorType).toBe("CLIENT");
    expect(event.actorEmail).toBe("client@example.com");
    expect(event.actorUserId).toBeNull();
  });

  describe("revision-round cap and escalation", () => {
    async function advanceToExpoProofCheck(orderId: string) {
      await transitionArtworkOrder(orderId, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
      await transitionArtworkOrder(orderId, "SUBMITTED", "SUBMIT", CLIENT_ACTOR);
      await transitionArtworkOrder(orderId, "UNDER_ART_REVIEW", "AUTO_ROUTE", { type: "SYSTEM" });
      await transitionArtworkOrder(orderId, "ACCEPTED", "APPROVE", EXPO_ACTOR);
      await transitionArtworkOrder(orderId, "VENDOR_ASSIGNED", "ASSIGN_VENDOR", EXPO_ACTOR);
      await transitionArtworkOrder(orderId, "PROOF_IN_PROGRESS", "VENDOR_NOTIFIED", { type: "SYSTEM" });
      await transitionArtworkOrder(orderId, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
      return transitionArtworkOrder(orderId, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });
    }

    it("increments revisionRound on the 1st and 2nd revision request without escalating", async () => {
      const order = await makeArtworkOrder();
      await advanceToExpoProofCheck(order.id);

      const first = await transitionArtworkOrder(order.id, "PROOF_REVISION_REQUESTED", "REQUEST_REVISION", EXPO_ACTOR, {
        note: "Logo bleed mismatch",
      });
      expect(first.artworkOrder.status).toBe("PROOF_REVISION_REQUESTED");
      expect(first.artworkOrder.revisionRound).toBe(1);
      expect(first.escalated).toBe(false);

      await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_REVISING", VENDOR_ACTOR);
      await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
      await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });

      const second = await transitionArtworkOrder(order.id, "PROOF_REVISION_REQUESTED", "REQUEST_REVISION", EXPO_ACTOR);
      expect(second.artworkOrder.status).toBe("PROOF_REVISION_REQUESTED");
      expect(second.artworkOrder.revisionRound).toBe(2);
      expect(second.escalated).toBe(false);
    });

    it("auto-escalates instead of allowing a 3rd revision round, capping revisionRound at 2", async () => {
      const order = await makeArtworkOrder();
      await advanceToExpoProofCheck(order.id);

      for (let round = 0; round < MAX_REVISION_ROUNDS; round++) {
        await transitionArtworkOrder(order.id, "PROOF_REVISION_REQUESTED", "REQUEST_REVISION", EXPO_ACTOR);
        await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_REVISING", VENDOR_ACTOR);
        await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
        await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });
      }

      const third = await transitionArtworkOrder(order.id, "PROOF_REVISION_REQUESTED", "REQUEST_REVISION", EXPO_ACTOR);
      expect(third.artworkOrder.status).toBe("ESCALATED");
      expect(third.artworkOrder.revisionRound).toBe(MAX_REVISION_ROUNDS);
      expect(third.escalated).toBe(true);
    });

    it("refuses to resolve an escalation without a resolution note", async () => {
      const order = await makeArtworkOrder();
      await advanceToExpoProofCheck(order.id);
      for (let round = 0; round < MAX_REVISION_ROUNDS + 1; round++) {
        await transitionArtworkOrder(order.id, "PROOF_REVISION_REQUESTED", "REQUEST_REVISION", EXPO_ACTOR);
        if (round < MAX_REVISION_ROUNDS) {
          await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_REVISING", VENDOR_ACTOR);
          await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
          await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });
        }
      }

      await expect(
        transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "ESCALATION_RESOLVED", EXPO_ACTOR),
      ).rejects.toThrow(/resolution note/);
    });

    it("resolving an escalation with a note resets revisionRound to 0 and marks the event internal-only", async () => {
      const order = await makeArtworkOrder();
      await advanceToExpoProofCheck(order.id);
      for (let round = 0; round < MAX_REVISION_ROUNDS + 1; round++) {
        await transitionArtworkOrder(order.id, "PROOF_REVISION_REQUESTED", "REQUEST_REVISION", EXPO_ACTOR);
        if (round < MAX_REVISION_ROUNDS) {
          await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_REVISING", VENDOR_ACTOR);
          await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
          await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });
        }
      }

      const resolved = await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "ESCALATION_RESOLVED", EXPO_ACTOR, {
        detail: { contactedWho: "Vendor ops lead", outcome: "revised quote issued", note: "Agreed to redo bleed" },
      });
      expect(resolved.artworkOrder.status).toBe("PROOF_IN_PROGRESS");
      expect(resolved.artworkOrder.revisionRound).toBe(0);
      expect(resolved.event.restrictedToInternal).toBe(true);
    });

    it("forces restrictedToInternal true on escalation resolution even if the caller passes false", async () => {
      const order = await makeArtworkOrder();
      await advanceToExpoProofCheck(order.id);
      for (let round = 0; round < MAX_REVISION_ROUNDS + 1; round++) {
        await transitionArtworkOrder(order.id, "PROOF_REVISION_REQUESTED", "REQUEST_REVISION", EXPO_ACTOR);
        if (round < MAX_REVISION_ROUNDS) {
          await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_REVISING", VENDOR_ACTOR);
          await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
          await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });
        }
      }

      const resolved = await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "ESCALATION_RESOLVED", EXPO_ACTOR, {
        detail: { contactedWho: "Vendor ops lead", outcome: "revised quote issued" },
        restrictedToInternal: false,
      });
      expect(resolved.event.restrictedToInternal).toBe(true);
    });
  });

  describe("SLA computation", () => {
    it("sets a 24h SLA when entering ExpoProofCheck outside the show's final week", async () => {
      const farOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const order = await makeArtworkOrder(farOut);
      await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
      await transitionArtworkOrder(order.id, "SUBMITTED", "SUBMIT", CLIENT_ACTOR);
      await transitionArtworkOrder(order.id, "UNDER_ART_REVIEW", "AUTO_ROUTE", { type: "SYSTEM" });
      await transitionArtworkOrder(order.id, "ACCEPTED", "APPROVE", EXPO_ACTOR);
      await transitionArtworkOrder(order.id, "VENDOR_ASSIGNED", "ASSIGN_VENDOR", EXPO_ACTOR);
      await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_NOTIFIED", { type: "SYSTEM" });
      await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
      const { artworkOrder } = await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });

      const hoursOut = (artworkOrder.slaDueAt!.getTime() - Date.now()) / (60 * 60 * 1000);
      expect(hoursOut).toBeGreaterThan(23);
      expect(hoursOut).toBeLessThan(25);
    });

    it("tightens to a 4h SLA when the show's eventStartDate is within the final week", async () => {
      const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const order = await makeArtworkOrder(soon);
      await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
      await transitionArtworkOrder(order.id, "SUBMITTED", "SUBMIT", CLIENT_ACTOR);
      await transitionArtworkOrder(order.id, "UNDER_ART_REVIEW", "AUTO_ROUTE", { type: "SYSTEM" });
      await transitionArtworkOrder(order.id, "ACCEPTED", "APPROVE", EXPO_ACTOR);
      await transitionArtworkOrder(order.id, "VENDOR_ASSIGNED", "ASSIGN_VENDOR", EXPO_ACTOR);
      await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_NOTIFIED", { type: "SYSTEM" });
      await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
      const { artworkOrder } = await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });

      const hoursOut = (artworkOrder.slaDueAt!.getTime() - Date.now()) / (60 * 60 * 1000);
      expect(hoursOut).toBeGreaterThan(3);
      expect(hoursOut).toBeLessThan(5);
    });

    it("defaults to the normal 24h window when the opportunity has no eventStartDate", async () => {
      const order = await makeArtworkOrder(null);
      await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
      await transitionArtworkOrder(order.id, "SUBMITTED", "SUBMIT", CLIENT_ACTOR);
      await transitionArtworkOrder(order.id, "UNDER_ART_REVIEW", "AUTO_ROUTE", { type: "SYSTEM" });
      await transitionArtworkOrder(order.id, "ACCEPTED", "APPROVE", EXPO_ACTOR);
      await transitionArtworkOrder(order.id, "VENDOR_ASSIGNED", "ASSIGN_VENDOR", EXPO_ACTOR);
      await transitionArtworkOrder(order.id, "PROOF_IN_PROGRESS", "VENDOR_NOTIFIED", { type: "SYSTEM" });
      await transitionArtworkOrder(order.id, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
      const { artworkOrder } = await transitionArtworkOrder(order.id, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });

      const hoursOut = (artworkOrder.slaDueAt!.getTime() - Date.now()) / (60 * 60 * 1000);
      expect(hoursOut).toBeGreaterThan(23);
      expect(hoursOut).toBeLessThan(25);
    });
  });

  describe("computeSlaDueAt (pure function)", () => {
    it("returns 24h out with no eventStartDate", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const due = computeSlaDueAt(now, null);
      expect(due.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it("returns 4h out when eventStartDate is exactly at the 7-day boundary", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const eventStartDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const due = computeSlaDueAt(now, eventStartDate);
      expect(due.getTime() - now.getTime()).toBe(4 * 60 * 60 * 1000);
    });

    it("returns 24h out when eventStartDate is just beyond the 7-day boundary", () => {
      const now = new Date("2026-01-01T00:00:00Z");
      const eventStartDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000 + 1000);
      const due = computeSlaDueAt(now, eventStartDate);
      expect(due.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
    });
  });
});

describe("submitArtworkOrder", () => {
  it("chains straight through to UnderArtReview on a normal (non-custom-size) order", async () => {
    const order = await makeArtworkOrder();
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    const { artworkOrder } = await submitArtworkOrder(order.id, CLIENT_ACTOR);
    expect(artworkOrder.status).toBe("UNDER_ART_REVIEW");
  });

  it("refuses to submit a custom-size order before the quote is accepted", async () => {
    const order = await makeArtworkOrder();
    await db.artworkOrder.update({ where: { id: order.id }, data: { customSizeRequested: true } });
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await expect(submitArtworkOrder(order.id, CLIENT_ACTOR)).rejects.toThrow(/custom-size quote/);
  });

  it("refuses to submit even after a quote is issued but not yet accepted", async () => {
    const order = await makeArtworkOrder();
    await db.artworkOrder.update({ where: { id: order.id }, data: { customSizeRequested: true } });
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await setCustomSizeQuote(order.id, 250, EXPO_ACTOR);
    await expect(submitArtworkOrder(order.id, CLIENT_ACTOR)).rejects.toThrow(/custom-size quote/);
  });

  it("allows submission once the custom-size quote is issued and accepted", async () => {
    const order = await makeArtworkOrder();
    await db.artworkOrder.update({ where: { id: order.id }, data: { customSizeRequested: true } });
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await setCustomSizeQuote(order.id, 250, EXPO_ACTOR);
    await acceptCustomSizeQuote(order.id, CLIENT_ACTOR);
    const { artworkOrder } = await submitArtworkOrder(order.id, CLIENT_ACTOR);
    expect(artworkOrder.status).toBe("UNDER_ART_REVIEW");
  });
});

describe("acceptCustomSizeQuote", () => {
  it("refuses to accept a quote that was never issued", async () => {
    const order = await makeArtworkOrder();
    await expect(acceptCustomSizeQuote(order.id, CLIENT_ACTOR)).rejects.toThrow(/no custom-size quote/i);
  });
});

describe("setProductionSpec", () => {
  it("sets width, height, and bleed, and logs an annotation-only event", async () => {
    const order = await makeArtworkOrder();
    const { artworkOrder, event } = await setProductionSpec(
      order.id,
      { widthIn: 96, heightIn: 42, bleedIn: 0.25 },
      EXPO_ACTOR,
    );
    expect(artworkOrder.customWidth?.toNumber()).toBe(96);
    expect(artworkOrder.customHeight?.toNumber()).toBe(42);
    expect(artworkOrder.bleedIn?.toNumber()).toBe(0.25);
    // Same-status call -- an annotation, not a real transition (see
    // transitionArtworkOrder's own comment on this pattern).
    expect(event.fromStatus).toBe(event.toStatus);
    expect(event.action).toBe("SET_PRODUCTION_SPEC");
  });

  it("leaves a field untouched when its value is undefined, unlike a plain-form clear", async () => {
    const order = await makeArtworkOrder();
    await setProductionSpec(order.id, { widthIn: 96, heightIn: 42, bleedIn: 0.25 }, EXPO_ACTOR);

    const { artworkOrder } = await setProductionSpec(order.id, { bleedIn: 0.5 }, EXPO_ACTOR);
    expect(artworkOrder.customWidth?.toNumber()).toBe(96);
    expect(artworkOrder.customHeight?.toNumber()).toBe(42);
    expect(artworkOrder.bleedIn?.toNumber()).toBe(0.5);
  });

  it("clears a field when its value is explicitly null", async () => {
    const order = await makeArtworkOrder();
    await setProductionSpec(order.id, { widthIn: 96, heightIn: 42, bleedIn: 0.25 }, EXPO_ACTOR);

    const { artworkOrder } = await setProductionSpec(order.id, { bleedIn: null }, EXPO_ACTOR);
    expect(artworkOrder.customWidth?.toNumber()).toBe(96);
    expect(artworkOrder.bleedIn).toBeNull();
  });
});

describe("acceptArtworkOrder", () => {
  async function makeReviewableOrder(wantsExpoProducedArt: boolean) {
    const tier = await db.artworkSizeTier.create({
      data: { label: "10x20 std", expoProducedFee: 150 },
    });
    const order = await makeArtworkOrder();
    await db.artworkOrder.update({ where: { id: order.id }, data: { sizeTierId: tier.id, wantsExpoProducedArt } });
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await submitArtworkOrder(order.id, CLIENT_ACTOR);
    return order.id;
  }

  it("computes expoProducedFee from the size tier when the client opted in", async () => {
    const orderId = await makeReviewableOrder(true);
    const { artworkOrder } = await acceptArtworkOrder(orderId, EXPO_ACTOR);
    expect(artworkOrder.status).toBe("ACCEPTED");
    expect(artworkOrder.expoProducedFee?.toString()).toBe("150");
  });

  it("leaves expoProducedFee null when the client did not opt in", async () => {
    const orderId = await makeReviewableOrder(false);
    const { artworkOrder } = await acceptArtworkOrder(orderId, EXPO_ACTOR);
    expect(artworkOrder.expoProducedFee).toBeNull();
  });
});

describe("assignVendor", () => {
  it("sets vendorId and chains straight through to ProofInProgress", async () => {
    const vendor = await db.vendor.create({ data: { name: "PrintCo Solutions", email: "jobs@printco.example" } });
    const order = await makeArtworkOrder();
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await submitArtworkOrder(order.id, CLIENT_ACTOR);
    await acceptArtworkOrder(order.id, EXPO_ACTOR);

    const { artworkOrder } = await assignVendor(order.id, vendor.id, EXPO_ACTOR);
    expect(artworkOrder.status).toBe("PROOF_IN_PROGRESS");
    expect(artworkOrder.vendorId).toBe(vendor.id);

    const statuses = (await db.artworkOrderEvent.findMany({ where: { artworkOrderId: order.id }, orderBy: { createdAt: "asc" } })).map(
      (e) => e.toStatus,
    );
    expect(statuses).toContain("VENDOR_ASSIGNED");
    expect(statuses).toContain("PROOF_IN_PROGRESS");
  });
});

describe("uploadProof", () => {
  it("chains straight through to ExpoProofCheck and sets an SLA due date", async () => {
    const vendor = await db.vendor.create({ data: { name: "PrintCo Solutions", email: "jobs@printco.example" } });
    const order = await makeArtworkOrder();
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await submitArtworkOrder(order.id, CLIENT_ACTOR);
    await acceptArtworkOrder(order.id, EXPO_ACTOR);
    await assignVendor(order.id, vendor.id, EXPO_ACTOR);

    const { artworkOrder } = await uploadProof(order.id, VENDOR_ACTOR);
    expect(artworkOrder.status).toBe("EXPO_PROOF_CHECK");
    expect(artworkOrder.slaDueAt).not.toBeNull();
  });
});

describe("updateArtworkOrderDraft", () => {
  it("updates fields while ORDER_DRAFTED", async () => {
    const order = await makeArtworkOrder();
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    const updated = await updateArtworkOrderDraft(order.id, { material: "Fabric", qty: 2 });
    expect(updated.material).toBe("Fabric");
    expect(updated.qty).toBe(2);
  });

  it("allows updates while REJECTED (resubmission)", async () => {
    const order = await makeArtworkOrder();
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await transitionArtworkOrder(order.id, "SUBMITTED", "SUBMIT", CLIENT_ACTOR);
    await transitionArtworkOrder(order.id, "UNDER_ART_REVIEW", "AUTO_ROUTE", { type: "SYSTEM" });
    await transitionArtworkOrder(order.id, "REJECTED", "REJECT", EXPO_ACTOR, { note: "Low resolution" });
    const updated = await updateArtworkOrderDraft(order.id, { material: "Vinyl" });
    expect(updated.material).toBe("Vinyl");
  });

  it("refuses to edit fields once submitted", async () => {
    const order = await makeArtworkOrder();
    await transitionArtworkOrder(order.id, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
    await transitionArtworkOrder(order.id, "SUBMITTED", "SUBMIT", CLIENT_ACTOR);
    await expect(updateArtworkOrderDraft(order.id, { material: "Vinyl" })).rejects.toThrow(/only be edited/);
  });
});

// Walks an order straight to IN_PRODUCTION for the Graphics Production Hub
// tests below -- same steps as the "walks the full happy path" test above,
// just stopping earlier.
async function advanceToInProduction(orderId: string) {
  await transitionArtworkOrder(orderId, "ORDER_DRAFTED", "OPEN_PORTAL", CLIENT_ACTOR);
  await transitionArtworkOrder(orderId, "SUBMITTED", "SUBMIT", CLIENT_ACTOR);
  await transitionArtworkOrder(orderId, "UNDER_ART_REVIEW", "AUTO_ROUTE", { type: "SYSTEM" });
  await transitionArtworkOrder(orderId, "ACCEPTED", "APPROVE", EXPO_ACTOR);
  await transitionArtworkOrder(orderId, "VENDOR_ASSIGNED", "ASSIGN_VENDOR", EXPO_ACTOR);
  await transitionArtworkOrder(orderId, "PROOF_IN_PROGRESS", "VENDOR_NOTIFIED", { type: "SYSTEM" });
  await transitionArtworkOrder(orderId, "PROOF_SUBMITTED", "UPLOAD_PROOF", VENDOR_ACTOR);
  await transitionArtworkOrder(orderId, "EXPO_PROOF_CHECK", "QUEUE_FOR_CHECK", { type: "SYSTEM" });
  await transitionArtworkOrder(orderId, "PROOF_UNDER_REVIEW", "CONFIRM_MATCH", EXPO_ACTOR);
  await transitionArtworkOrder(orderId, "PROOF_APPROVED", "CLIENT_SIGN_OFF", CLIENT_ACTOR);
  await transitionArtworkOrder(orderId, "PRODUCTION_GO_AHEAD", "ISSUE_GO_AHEAD", EXPO_ACTOR);
  await transitionArtworkOrder(orderId, "IN_PRODUCTION", "SENT_TO_PRODUCTION", VENDOR_ACTOR);
}

describe("Graphics Production Hub: new production waypoints", () => {
  it("allows the optional RECEIVED_FROM_VENDOR -> INSPECTED -> PACKAGED_READY path", async () => {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    await transitionArtworkOrder(order.id, "RECEIVED_FROM_VENDOR", "RECEIVED", EXPO_ACTOR);
    await transitionArtworkOrder(order.id, "INSPECTED", "INSPECT", EXPO_ACTOR);
    const { artworkOrder } = await transitionArtworkOrder(order.id, "PACKAGED_READY", "PACKAGED", VENDOR_ACTOR);
    expect(artworkOrder.status).toBe("PACKAGED_READY");
  });

  it("still allows skipping straight to PACKAGED_READY (matches most historical data)", async () => {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    const { artworkOrder } = await transitionArtworkOrder(order.id, "PACKAGED_READY", "PACKAGED", VENDOR_ACTOR);
    expect(artworkOrder.status).toBe("PACKAGED_READY");
  });

  it("REPRINT_REQUESTED loops back to IN_PRODUCTION", async () => {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    await transitionArtworkOrder(order.id, "REPRINT_REQUESTED", "REPRINT", EXPO_ACTOR);
    const { artworkOrder } = await transitionArtworkOrder(order.id, "IN_PRODUCTION", "SENT_TO_PRODUCTION", VENDOR_ACTOR);
    expect(artworkOrder.status).toBe("IN_PRODUCTION");
  });
});

describe("cancelArtworkOrder", () => {
  it("cancels an order from a pre-delivery status without an edge in ARTWORK_TRANSITIONS", async () => {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    const { artworkOrder, event } = await cancelArtworkOrder(order.id, EXPO_ACTOR, "Client pulled out of the show");
    expect(artworkOrder.status).toBe("CANCELLED");
    expect(event.action).toBe("CANCEL");
    expect(event.note).toBe("Client pulled out of the show");
  });

  it("refuses to cancel an order that's already DELIVERED_AT_SHOW", async () => {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    await transitionArtworkOrder(order.id, "PACKAGED_READY", "PACKAGED", VENDOR_ACTOR);
    await transitionArtworkOrder(order.id, "SHIPPED_TO_SHOW", "SHIPPED", VENDOR_ACTOR);
    await transitionArtworkOrder(order.id, "DELIVERED_AT_SHOW", "DELIVERED", EXPO_ACTOR);
    await expect(cancelArtworkOrder(order.id, EXPO_ACTOR)).rejects.toThrow(/Cannot cancel/);
  });

  it("refuses to cancel an order that's already cancelled", async () => {
    const order = await makeArtworkOrder();
    await cancelArtworkOrder(order.id, EXPO_ACTOR);
    await expect(cancelArtworkOrder(order.id, EXPO_ACTOR)).rejects.toThrow(/Cannot cancel/);
  });
});

describe("setProductionDetail", () => {
  it("sets the new per-piece fields and leaves the order's status unchanged", async () => {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    const { artworkOrder } = await setProductionDetail(
      order.id,
      { graphicCode: "A1", finishingDetails: "SEG", verifiedSizes: true, existingGraphicsStatus: "NEW_IMAGE" },
      EXPO_ACTOR,
    );
    expect(artworkOrder.status).toBe("IN_PRODUCTION");
    expect(artworkOrder.graphicCode).toBe("A1");
    expect(artworkOrder.finishingDetails).toBe("SEG");
    expect(artworkOrder.verifiedSizes).toBe(true);
    expect(artworkOrder.existingGraphicsStatus).toBe("NEW_IMAGE");
  });

  it("leaves an omitted field unchanged", async () => {
    const order = await makeArtworkOrder();
    await setProductionDetail(order.id, { graphicCode: "A1" }, EXPO_ACTOR);
    const { artworkOrder } = await setProductionDetail(order.id, { finishingDetails: "Grommets" }, EXPO_ACTOR);
    expect(artworkOrder.graphicCode).toBe("A1");
    expect(artworkOrder.finishingDetails).toBe("Grommets");
  });
});

describe("recordPostShowDisposition", () => {
  async function advanceToDelivered(orderId: string) {
    await advanceToInProduction(orderId);
    await transitionArtworkOrder(orderId, "PACKAGED_READY", "PACKAGED", VENDOR_ACTOR);
    await transitionArtworkOrder(orderId, "SHIPPED_TO_SHOW", "SHIPPED", VENDOR_ACTOR);
    await transitionArtworkOrder(orderId, "DELIVERED_AT_SHOW", "DELIVERED", EXPO_ACTOR);
  }

  it("records post-show status/condition once delivered", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    const { artworkOrder } = await recordPostShowDisposition(
      order.id,
      { postShowStatus: "EXPO_STORAGE", postShowCondition: "OK_TO_REUSE" },
      EXPO_ACTOR,
    );
    expect(artworkOrder.postShowStatus).toBe("EXPO_STORAGE");
    expect(artworkOrder.postShowCondition).toBe("OK_TO_REUSE");
    expect(artworkOrder.postShowRecordedAt).not.toBeNull();
  });

  it("refuses to record a disposition before the order has been delivered", async () => {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    await expect(
      recordPostShowDisposition(order.id, { postShowStatus: "DISCARDED", postShowCondition: null }, EXPO_ACTOR),
    ).rejects.toThrow(/only be recorded once/);
  });

  it("refuses to mark a piece Discarded with no discard reason", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    await expect(
      recordPostShowDisposition(order.id, { postShowStatus: "DISCARDED", postShowCondition: null }, EXPO_ACTOR),
    ).rejects.toThrow(/discard reason is required/);
  });

  it("refuses a discard reason on a non-Discarded disposition", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    await expect(
      recordPostShowDisposition(
        order.id,
        {
          postShowStatus: "EXPO_STORAGE",
          postShowCondition: "OK_TO_REUSE",
          postShowDiscardReason: "DAMAGED_BEYOND_REPAIR",
          postShowConditionNote: "n/a",
        },
        EXPO_ACTOR,
      ),
    ).rejects.toThrow(/only applies when the disposition is Discarded/);
  });

  it("refuses a client-approved disposal with no approver recorded", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    await expect(
      recordPostShowDisposition(
        order.id,
        {
          postShowStatus: "DISCARDED",
          postShowCondition: "OK_TO_REUSE",
          postShowDiscardReason: "CLIENT_APPROVED_DISPOSAL",
          postShowConditionNote: "client said toss it",
        },
        EXPO_ACTOR,
      ),
    ).rejects.toThrow(/who approved/);
  });

  it("refuses an approver name on a non-client-approved discard reason", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    await expect(
      recordPostShowDisposition(
        order.id,
        {
          postShowStatus: "DISCARDED",
          postShowCondition: "DAMAGED",
          postShowDiscardReason: "DAMAGED_BEYOND_REPAIR",
          postShowConditionNote: "torn beyond repair",
          postShowDisposalApprovedBy: "Someone",
        },
        EXPO_ACTOR,
      ),
    ).rejects.toThrow(/approver name only applies/);
  });

  it("refuses Damaged or Aging condition with no note explaining it", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    await db.artworkFile.create({
      data: {
        artworkOrderId: order.id,
        kind: "POST_SHOW_CONDITION_PHOTO",
        filename: "photo-1.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1000,
        storageKey: "test/photo-1.jpg",
        uploadedByType: "EXPO",
      },
    });
    await expect(
      recordPostShowDisposition(order.id, { postShowStatus: "EXPO_STORAGE", postShowCondition: "DAMAGED" }, EXPO_ACTOR),
    ).rejects.toThrow(/note is required/);

    const aeOrder = await makeArtworkOrder();
    await advanceToDelivered(aeOrder.id);
    await expect(
      recordPostShowDisposition(aeOrder.id, { postShowStatus: "EXPO_STORAGE", postShowCondition: "AGING" }, EXPO_ACTOR),
    ).rejects.toThrow(/note is required/);
  });

  it("refuses a Damaged condition with no reference photo on file", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    await expect(
      recordPostShowDisposition(
        order.id,
        { postShowStatus: "EXPO_STORAGE", postShowCondition: "DAMAGED", postShowConditionNote: "torn corner" },
        EXPO_ACTOR,
      ),
    ).rejects.toThrow(/Upload at least one reference photo/);
  });

  it("records a full Damaged disposition once a photo and note are both present", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    await db.artworkFile.create({
      data: {
        artworkOrderId: order.id,
        kind: "POST_SHOW_CONDITION_PHOTO",
        filename: "photo-1.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1000,
        storageKey: "test/photo-1.jpg",
        uploadedByType: "EXPO",
      },
    });
    const { artworkOrder } = await recordPostShowDisposition(
      order.id,
      { postShowStatus: "EXPO_STORAGE", postShowCondition: "DAMAGED", postShowConditionNote: "torn corner, still usable" },
      EXPO_ACTOR,
    );
    expect(artworkOrder.postShowCondition).toBe("DAMAGED");
    expect(artworkOrder.postShowConditionNote).toBe("torn corner, still usable");
  });

  it("records a client-approved disposal with the approver's name", async () => {
    const order = await makeArtworkOrder();
    await advanceToDelivered(order.id);
    const { artworkOrder } = await recordPostShowDisposition(
      order.id,
      {
        postShowStatus: "DISCARDED",
        postShowCondition: "OK_TO_REUSE",
        postShowDiscardReason: "CLIENT_APPROVED_DISPOSAL",
        postShowConditionNote: "client confirmed on call",
        postShowDisposalApprovedBy: "Jane Client",
      },
      EXPO_ACTOR,
    );
    expect(artworkOrder.postShowDiscardReason).toBe("CLIENT_APPROVED_DISPOSAL");
    expect(artworkOrder.postShowDisposalApprovedBy).toBe("Jane Client");
  });
});

describe("recordAgingDecision", () => {
  async function makeAgingOrder() {
    const order = await makeArtworkOrder();
    await advanceToInProduction(order.id);
    await transitionArtworkOrder(order.id, "PACKAGED_READY", "PACKAGED", VENDOR_ACTOR);
    await transitionArtworkOrder(order.id, "SHIPPED_TO_SHOW", "SHIPPED", VENDOR_ACTOR);
    await transitionArtworkOrder(order.id, "DELIVERED_AT_SHOW", "DELIVERED", EXPO_ACTOR);
    await recordPostShowDisposition(
      order.id,
      { postShowStatus: "EXPO_STORAGE", postShowCondition: "AGING", postShowConditionNote: "edges fraying" },
      EXPO_ACTOR,
    );
    return order;
  }

  it("refuses when the piece isn't currently flagged Aging", async () => {
    const order = await makeArtworkOrder();
    await expect(recordAgingDecision(order.id, "KEEP_IN_CIRCULATION", EXPO_ACTOR)).rejects.toThrow(
      /isn't currently flagged as aging/,
    );
  });

  it("logs a keep-in-circulation decision without changing any disposition fields", async () => {
    const order = await makeAgingOrder();
    const { event } = await recordAgingDecision(order.id, "KEEP_IN_CIRCULATION", EXPO_ACTOR, "client wants to keep using it");
    expect(event.action).toBe("AGING_KEPT_IN_CIRCULATION");
    const reloaded = await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.postShowCondition).toBe("AGING");
  });

  it("logs a mark-for-replacement decision", async () => {
    const order = await makeAgingOrder();
    const { event } = await recordAgingDecision(order.id, "MARK_FOR_REPLACEMENT", EXPO_ACTOR, "client wants a fresh one");
    expect(event.action).toBe("AGING_MARKED_FOR_REPLACEMENT");
  });
});

describe("rolloverArtworkOrder", () => {
  it("copies a prior piece's fields into a new order, marks it EXISTING, and links rolledOverFromId", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const vendor = await db.vendor.create({ data: { name: "Test Vendor" } });
    const sourceOpportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "PGA Show 2026" },
    });
    const targetOpportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "PGA Show 2027" },
    });
    const source = await db.artworkOrder.create({
      data: {
        opportunityId: sourceOpportunity.id,
        jobCode: "EXPO-SOURCE1",
        material: "Vinyl",
        qty: 3,
        graphicCode: "GC-001",
        finishingDetails: "Grommets",
        customWidth: 48,
        customHeight: 96,
        vendorId: vendor.id,
      },
    });

    const rolled = await rolloverArtworkOrder(source, { opportunityId: targetOpportunity.id }, EXPO_ACTOR);

    expect(rolled.opportunityId).toBe(targetOpportunity.id);
    expect(rolled.jobCode).not.toBe(source.jobCode);
    expect(rolled.material).toBe("Vinyl");
    expect(rolled.qty).toBe(3);
    expect(rolled.graphicCode).toBe("GC-001");
    expect(rolled.finishingDetails).toBe("Grommets");
    expect(rolled.vendorId).toBe(vendor.id);
    expect(Number(rolled.customWidth)).toBe(48);
    expect(Number(rolled.customHeight)).toBe(96);
    expect(rolled.existingGraphicsStatus).toBe("EXISTING");
    expect(rolled.rolledOverFromId).toBe(source.id);
    expect(rolled.status).toBe("INVITED");

    const event = await db.artworkOrderEvent.findFirst({ where: { artworkOrderId: rolled.id } });
    expect(event?.action).toBe("ROLLED_OVER_FROM_PRIOR_SHOW");
    expect(event?.fromStatus).toBe("INVITED");
    expect(event?.toStatus).toBe("INVITED");
    expect(event?.detail).toMatchObject({ fromArtworkOrderId: source.id });
  });

  it("rolls a Hub/hanging-sign piece (no opportunity) directly under the target show", async () => {
    const sourceShow = await db.show.create({ data: { name: "PGA Show 2026" } });
    const targetShow = await db.show.create({ data: { name: "PGA Show 2027" } });
    const source = await db.artworkOrder.create({
      data: { showId: sourceShow.id, jobCode: "EXPO-HUB1", graphicCode: "HUB-01", qty: 1 },
    });

    const rolled = await rolloverArtworkOrder(source, { showId: targetShow.id }, EXPO_ACTOR);

    expect(rolled.showId).toBe(targetShow.id);
    expect(rolled.opportunityId).toBeNull();
    expect(rolled.existingGraphicsStatus).toBe("EXISTING");
    expect(rolled.rolledOverFromId).toBe(source.id);
  });
});
