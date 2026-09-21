import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  isActualReprint,
  REPRINT_REASONS,
  REPRINT_REASON_LABELS,
  reprintNoteRequired,
  reprintReasonFromTracker,
  reprintReasonRequired,
} from "@/lib/artwork-reprint";
import { requestReprint, transitionArtworkOrder } from "@/lib/artwork-order-service";
import { UserError } from "@/lib/user-error";

const ACTOR = { type: "EXPO" as const, userId: null };

afterEach(async () => {
  await db.artworkOrderRouting.deleteMany();
  await db.artworkOrderEvent.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("reprintReasonFromTracker", () => {
  it("maps her six values as her list spells them", () => {
    expect(reprintReasonFromTracker("Reprint - Production Quality")).toBe("PRODUCTION_QUALITY");
    expect(reprintReasonFromTracker("Reprint - Transport/Handling Damage")).toBe("TRANSPORT_HANDLING_DAMAGE");
    expect(reprintReasonFromTracker("Reprint - Install/Site Damage")).toBe("INSTALL_SITE_DAMAGE");
    expect(reprintReasonFromTracker("Reprint - Client Changes")).toBe("CLIENT_CHANGES");
    expect(reprintReasonFromTracker("New Order (Upsell)")).toBe("NEW_ORDER_UPSELL");
  });

  it("accepts both spellings of Other, which differ between her list and her data", () => {
    // Configured list vs what the site-only export actually contains.
    expect(reprintReasonFromTracker("Other (Missing, Not Requested, etc)")).toBe("OTHER");
    expect(reprintReasonFromTracker("Other (Missing, Not requested etc)")).toBe("OTHER");
  });

  it("returns null for anything unrecognised rather than guessing", () => {
    expect(reprintReasonFromTracker("")).toBeNull();
    expect(reprintReasonFromTracker(null)).toBeNull();
    expect(reprintReasonFromTracker("Reprint - something new")).toBeNull();
  });
});

describe("isActualReprint", () => {
  it("excludes an upsell, which is billable work rather than a re-run", () => {
    expect(isActualReprint("NEW_ORDER_UPSELL")).toBe(false);
    expect(isActualReprint(null)).toBe(false);
  });

  it("counts every genuine reprint reason", () => {
    for (const r of REPRINT_REASONS.filter((x) => x !== "NEW_ORDER_UPSELL")) {
      expect(isActualReprint(r)).toBe(true);
    }
  });
});

describe("the SOP's recording rules", () => {
  it("requires a reason on site prints only", () => {
    expect(reprintReasonRequired("SITE")).toBe(true);
    expect(reprintReasonRequired("EXHIBITOR")).toBe(false);
    expect(reprintReasonRequired(null)).toBe(false);
  });

  it("requires a note when the category explains nothing on its own", () => {
    expect(reprintNoteRequired("OTHER")).toBe(true);
    expect(reprintNoteRequired("PRODUCTION_QUALITY")).toBe(false);
  });

  it("labels every reason, so a picker can't render a blank option", () => {
    for (const r of REPRINT_REASONS) expect(REPRINT_REASON_LABELS[r]).toBeTruthy();
  });
});

describe("requestReprint", () => {
  let n = 0;
  async function inProduction() {
    n += 1;
    const company = await db.company.create({ data: { name: `Reprint Co ${n}` } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Show", stage: "WON" } });
    const order = await db.artworkOrder.create({
      data: { opportunityId: opportunity.id, jobCode: `RP-${n}`, status: "IN_PRODUCTION" },
    });
    return order;
  }

  it("sends the piece back and records why", async () => {
    const order = await inProduction();
    await requestReprint(order.id, { reason: "PRODUCTION_QUALITY", note: "  banding across the top  " }, ACTOR);

    const after = await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("REPRINT_REQUESTED");
    expect(after.reprintReason).toBe("PRODUCTION_QUALITY");
    expect(after.reprintNote).toBe("banding across the top");
  });

  it("keeps the reason after the piece loops back into production", async () => {
    const order = await inProduction();
    await requestReprint(order.id, { reason: "INSTALL_SITE_DAMAGE" }, ACTOR);
    await transitionArtworkOrder(order.id, "IN_PRODUCTION", "REPRINT_STARTED", ACTOR);

    const after = await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } });
    // The status says a reprint is happening now; the reason says why it
    // ever did, and the yearly report is built from the latter.
    expect(after.status).toBe("IN_PRODUCTION");
    expect(after.reprintReason).toBe("INSTALL_SITE_DAMAGE");
  });

  it("refuses an upsell, which is a new piece and not a reprint", async () => {
    const order = await inProduction();
    await expect(requestReprint(order.id, { reason: "NEW_ORDER_UPSELL" }, ACTOR)).rejects.toThrow(/isn't a reprint/);
    expect((await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("IN_PRODUCTION");
  });

  it("refuses bare 'Other' with no explanation", async () => {
    const order = await inProduction();
    await expect(requestReprint(order.id, { reason: "OTHER", note: "   " }, ACTOR)).rejects.toThrow(UserError);
    await expect(requestReprint(order.id, { reason: "OTHER", note: "went missing in transit" }, ACTOR)).resolves.toBeDefined();
  });

  it("records the reason on the event, so the loop is auditable", async () => {
    const order = await inProduction();
    await requestReprint(order.id, { reason: "CLIENT_CHANGES" }, ACTOR);
    const event = await db.artworkOrderEvent.findFirstOrThrow({
      where: { artworkOrderId: order.id, toStatus: "REPRINT_REQUESTED" },
    });
    expect(event.detail).toMatchObject({ reprintReason: "CLIENT_CHANGES" });
  });
});
