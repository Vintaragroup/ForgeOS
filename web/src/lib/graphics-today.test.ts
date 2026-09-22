import { describe, expect, it } from "vitest";
import type { ArtworkOrderStatus } from "@/generated/prisma/enums";
import { ARTWORK_TRANSITIONS } from "@/lib/artwork-order-service";
import { buildTodayBuckets, NEXT_STEP, WAITING_ON, type TodayFacts } from "@/lib/graphics-today";

// A Wednesday, so adding/subtracting a few business days doesn't skip a
// weekend and make a test's intent hard to read.
const NOW = new Date("2026-09-23T12:00:00.000Z");

function days(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}

interface Piece extends TodayFacts {
  id: string;
}

function piece(id: string, overrides: Partial<TodayFacts> = {}): Piece {
  return {
    id,
    status: "IN_PRODUCTION",
    inHandDate: null,
    material: "Fabric (Black-Back)",
    graphicCode: null,
    showStartDate: null,
    ...overrides,
  };
}

function bucket(pieces: Piece[]) {
  return buildTodayBuckets(pieces, (p) => p, NOW);
}

describe("WAITING_ON", () => {
  it("covers every status in the pipeline", () => {
    for (const status of Object.keys(ARTWORK_TRANSITIONS) as ArtworkOrderStatus[]) {
      expect(WAITING_ON[status], `${status} has no owner`).toBeDefined();
      expect(NEXT_STEP[status], `${status} has no next step`).toBeTruthy();
    }
  });

  it("puts the proof sign-off on the client, not on us", () => {
    // The transition out of PROOF_UNDER_REVIEW is CLIENT_SIGN_OFF, and it
    // happens in the client portal -- chasing ourselves for it would be
    // chasing the wrong person.
    expect(WAITING_ON.PROOF_UNDER_REVIEW).toBe("CLIENT");
  });

  it("keeps packing and shipping with us, but not the transit itself", () => {
    expect(WAITING_ON.PACKAGED_READY).toBe("EXPO");
    expect(WAITING_ON.SHIPPED_TO_SHOW).toBe("NOBODY");
  });
});

describe("buildTodayBuckets", () => {
  it("ignores pieces that are travelling, delivered or cancelled", () => {
    const result = bucket([
      piece("shipped", { status: "SHIPPED_TO_SHOW", inHandDate: days(-30) }),
      piece("delivered", { status: "DELIVERED_AT_SHOW", inHandDate: days(-30) }),
      piece("cancelled", { status: "CANCELLED", inHandDate: days(-30) }),
    ]);
    expect(result.overdue).toHaveLength(0);
    expect(result.waitingOnUs).toHaveLength(0);
    expect(result.waitingOnOthers).toHaveLength(0);
    expect(result.needsYou).toBe(0);
  });

  it("flags a piece whose in-hand date has passed and still isn't made", () => {
    const result = bucket([piece("late", { status: "IN_PRODUCTION", inHandDate: days(-7) })]);
    expect(result.overdue.map((i) => i.order.id)).toEqual(["late"]);
    expect(result.overdue[0].sla.overdue).toBe(true);
  });

  it("does not call a packed piece overdue -- it already exists", () => {
    // PACKAGED_READY is still waiting on us (to ship it), but the in-hand
    // date is no longer a production risk.
    const result = bucket([piece("packed", { status: "PACKAGED_READY", inHandDate: days(-7) })]);
    expect(result.overdue).toHaveLength(0);
    expect(result.waitingOnUs.map((i) => i.order.id)).toEqual(["packed"]);
  });

  it("warns about a rush fee when there is less than the material's turnaround left", () => {
    // Fabric is 5 business days; 3 calendar days away is inside that.
    const result = bucket([piece("rush", { status: "ACCEPTED", inHandDate: days(3) })]);
    expect(result.rushRisk.map((i) => i.order.id)).toEqual(["rush"]);
    expect(result.overdue).toHaveLength(0);
  });

  it("leaves a piece with plenty of time out of both urgency buckets", () => {
    const result = bucket([piece("fine", { status: "IN_PRODUCTION", inHandDate: days(60) })]);
    expect(result.overdue).toHaveLength(0);
    expect(result.rushRisk).toHaveLength(0);
    expect(result.waitingOnOthers.map((i) => i.order.id)).toEqual(["fine"]);
  });

  it("says when the turnaround behind a warning was guessed", () => {
    // The Seatrade import produced 282 pieces with no material at all.
    // They still classify (as RIGID), but that is a default, not a fact.
    const [guessed, known] = bucket([
      piece("known", { status: "ACCEPTED", inHandDate: days(3), material: "Fabric (Black-Back)" }),
      piece("guessed", { status: "ACCEPTED", inHandDate: days(3), material: null }),
    ]).rushRisk.sort((a, b) => a.order.id.localeCompare(b.order.id));
    expect(guessed.turnaroundIsKnown).toBe(false);
    expect(known.turnaroundIsKnown).toBe(true);
  });

  it("flags an unapproved piece once its show is inside the 10-day approval window", () => {
    const result = bucket([piece("soon", { status: "UNDER_ART_REVIEW", showStartDate: days(7) })]);
    expect(result.approvalWindow.map((i) => i.order.id)).toEqual(["soon"]);
    expect(result.waitingOnUs).toHaveLength(0);
  });

  it("does not flag a piece that is already approved", () => {
    const result = bucket([piece("approved", { status: "PROOF_APPROVED", showStartDate: days(7) })]);
    expect(result.approvalWindow).toHaveLength(0);
    expect(result.waitingOnUs.map((i) => i.order.id)).toEqual(["approved"]);
  });

  it("does not flag a show that is still comfortably far off", () => {
    const result = bucket([piece("later", { status: "UNDER_ART_REVIEW", showStartDate: days(90) })]);
    expect(result.approvalWindow).toHaveLength(0);
    expect(result.waitingOnUs.map((i) => i.order.id)).toEqual(["later"]);
  });

  it("splits the rest by whose move it is", () => {
    const result = bucket([
      piece("ours", { status: "SUBMITTED" }),
      piece("client", { status: "REJECTED" }),
      piece("vendor", { status: "PROOF_IN_PROGRESS" }),
    ]);
    expect(result.waitingOnUs.map((i) => i.order.id)).toEqual(["ours"]);
    expect(result.waitingOnOthers.map((i) => i.order.id).sort()).toEqual(["client", "vendor"]);
    expect(result.waitingOnOthers.find((i) => i.order.id === "vendor")?.nextStep).toBe("Vendor proofing");
  });

  it("lists a piece in exactly one bucket", () => {
    // Overdue, unapproved, and inside the approval window all at once --
    // the old dashboard would have shown this row three times.
    const p = piece("everything", { status: "UNDER_ART_REVIEW", inHandDate: days(-5), showStartDate: days(3) });
    const result = bucket([p]);
    const appearances =
      result.overdue.length + result.rushRisk.length + result.approvalWindow.length +
      result.waitingOnUs.length + result.waitingOnOthers.length;
    expect(appearances).toBe(1);
    expect(result.overdue.map((i) => i.order.id)).toEqual(["everything"]);
  });

  it("puts the least time left first", () => {
    const result = bucket([
      piece("a", { status: "IN_PRODUCTION", inHandDate: days(-2) }),
      piece("b", { status: "IN_PRODUCTION", inHandDate: days(-20) }),
      piece("c", { status: "IN_PRODUCTION", inHandDate: days(-9) }),
    ]);
    expect(result.overdue.map((i) => i.order.id)).toEqual(["b", "c", "a"]);
  });

  it("puts the soonest show first in the waiting lists, undated pieces last", () => {
    const result = bucket([
      piece("undated", { status: "SUBMITTED" }),
      piece("far", { status: "SUBMITTED", showStartDate: days(200) }),
      piece("near", { status: "SUBMITTED", showStartDate: days(40) }),
    ]);
    expect(result.waitingOnUs.map((i) => i.order.id)).toEqual(["near", "far", "undated"]);
  });

  it("counts everything urgent plus everything sitting with us, and nothing else", () => {
    const result = bucket([
      piece("late", { status: "IN_PRODUCTION", inHandDate: days(-7) }),
      piece("rush", { status: "ACCEPTED", inHandDate: days(3) }),
      piece("approval", { status: "UNDER_ART_REVIEW", showStartDate: days(7) }),
      piece("ours", { status: "SUBMITTED" }),
      piece("theirs", { status: "PROOF_IN_PROGRESS" }),
    ]);
    expect(result.needsYou).toBe(4);
  });

  it("leaves a rolled-over piece with no in-hand date out of the urgency buckets", () => {
    // rolloverArtworkOrder deliberately does not carry last year's dates
    // forward. Treating a null date as urgent would have put all 281
    // rolled-over Seatrade pieces on the overdue list.
    const result = bucket([piece("rolled", { status: "INVITED", inHandDate: null, showStartDate: days(200) })]);
    expect(result.overdue).toHaveLength(0);
    expect(result.rushRisk).toHaveLength(0);
    expect(result.waitingOnOthers.map((i) => i.order.id)).toEqual(["rolled"]);
  });
});

describe("escalations", () => {
  it("ranks an escalated piece above every other bucket it also qualifies for", () => {
    // Overdue AND inside the approval window AND escalated. Nothing can
    // move until the escalation is resolved, so that is what the row says.
    const result = bucket([
      piece("stuck", { status: "ESCALATED", inHandDate: days(-5), showStartDate: days(3) }),
    ]);
    expect(result.escalated.map((i) => i.order.id)).toEqual(["stuck"]);
    expect(result.overdue).toHaveLength(0);
    expect(result.approvalWindow).toHaveLength(0);
    expect(result.waitingOnUs).toHaveLength(0);
    // The overdue fact is still carried on the row, just not as its bucket.
    expect(result.escalated[0].sla?.overdue).toBe(true);
  });

  it("sorts an escalation with no in-hand date last, not first", () => {
    const result = bucket([
      piece("undated", { status: "ESCALATED", inHandDate: null }),
      piece("late", { status: "ESCALATED", inHandDate: days(-9) }),
      piece("soon", { status: "ESCALATED", inHandDate: days(2) }),
    ]);
    expect(result.escalated.map((i) => i.order.id)).toEqual(["late", "soon", "undated"]);
  });

  it("counts escalations as needing you", () => {
    const result = bucket([piece("stuck", { status: "ESCALATED" })]);
    expect(result.needsYou).toBe(1);
  });
});
