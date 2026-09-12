import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createArtworkOrder } from "@/lib/artwork-order-service";
import { issuePortalInvite, requirePortalAccess, validatePortalToken } from "@/lib/artwork-portal-auth";

afterEach(async () => {
  await db.artworkPortalInvite.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeArtworkOrder() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return createArtworkOrder(opportunity.id);
}

describe("issuePortalInvite / validatePortalToken", () => {
  it("round-trips a valid invite into the identity it was issued for", async () => {
    const order = await makeArtworkOrder();
    const { magicLinkToken } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");

    const identity = await validatePortalToken(magicLinkToken);
    expect(identity).toEqual({ artworkOrderId: order.id, role: "CLIENT", email: "client@example.com" });
  });

  it("issues an invite whose tokenHash is stored, never the raw token", async () => {
    const order = await makeArtworkOrder();
    const { invite, magicLinkToken } = await issuePortalInvite(order.id, "VENDOR", "vendor@example.com");
    expect(magicLinkToken).not.toContain(invite.tokenHash);
    expect(invite.tokenHash).not.toBe(magicLinkToken.split(":")[1]);
  });

  it("is NOT single-use: a valid link keeps working across repeated visits", async () => {
    const order = await makeArtworkOrder();
    const { magicLinkToken } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");

    expect(await validatePortalToken(magicLinkToken)).not.toBeNull();
    expect(await validatePortalToken(magicLinkToken)).not.toBeNull();
    expect(await validatePortalToken(magicLinkToken)).not.toBeNull();
  });

  it("records usedAt on first validation only, without invalidating the token", async () => {
    const order = await makeArtworkOrder();
    const { invite, magicLinkToken } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");
    expect(invite.usedAt).toBeNull();

    await validatePortalToken(magicLinkToken);
    const afterFirst = await db.artworkPortalInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(afterFirst.usedAt).not.toBeNull();

    await validatePortalToken(magicLinkToken);
    const afterSecond = await db.artworkPortalInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(afterSecond.usedAt?.getTime()).toBe(afterFirst.usedAt?.getTime());
  });

  it("rejects an expired invite", async () => {
    const order = await makeArtworkOrder();
    const { invite, magicLinkToken } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");
    await db.artworkPortalInvite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await validatePortalToken(magicLinkToken)).toBeNull();
  });

  it("rejects a revoked invite even if it hasn't expired", async () => {
    const order = await makeArtworkOrder();
    const { invite, magicLinkToken } = await issuePortalInvite(order.id, "VENDOR", "vendor@example.com");
    await db.artworkPortalInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });

    expect(await validatePortalToken(magicLinkToken)).toBeNull();
  });

  it("rejects a tampered raw token even for a real invite id", async () => {
    const order = await makeArtworkOrder();
    const { invite } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");
    expect(await validatePortalToken(`${invite.id}:not-the-real-token`)).toBeNull();
  });

  it("rejects a malformed token with no separator", async () => {
    expect(await validatePortalToken("not-a-valid-token")).toBeNull();
  });

  // Regression: Next's dynamic [token] route params arrive with the URL's
  // ":" delimiter still percent-encoded as "%3A" rather than decoded (found
  // 2026-09-12 -- every real client/vendor magic link 404'd until this was
  // fixed). validatePortalToken must decode before splitting so it works
  // whether it's called with a raw params.token or an already-decoded one.
  it("validates a token that still has its ':' delimiter percent-encoded, as a raw route param would arrive", async () => {
    const order = await makeArtworkOrder();
    const { magicLinkToken } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");

    const identity = await validatePortalToken(encodeURIComponent(magicLinkToken));
    expect(identity).toEqual({ artworkOrderId: order.id, role: "CLIENT", email: "client@example.com" });
  });

  it("scopes each invite to its own artwork order -- a token for one order never resolves to another", async () => {
    const orderA = await makeArtworkOrder();
    const orderB = await makeArtworkOrder();
    const { magicLinkToken } = await issuePortalInvite(orderA.id, "CLIENT", "client@example.com");

    const identity = await validatePortalToken(magicLinkToken);
    expect(identity?.artworkOrderId).toBe(orderA.id);
    expect(identity?.artworkOrderId).not.toBe(orderB.id);
  });
});

describe("requirePortalAccess", () => {
  it("returns the identity when the token, artworkOrderId, and role all match", async () => {
    const order = await makeArtworkOrder();
    const { magicLinkToken } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");
    const identity = await requirePortalAccess(magicLinkToken, { artworkOrderId: order.id, role: "CLIENT" });
    expect(identity.email).toBe("client@example.com");
  });

  it("rejects an invalid token", async () => {
    await expect(requirePortalAccess("garbage", { artworkOrderId: "order-1", role: "CLIENT" })).rejects.toThrow(/denied/);
  });

  it("rejects a valid token used against a different artwork order", async () => {
    const orderA = await makeArtworkOrder();
    const orderB = await makeArtworkOrder();
    const { magicLinkToken } = await issuePortalInvite(orderA.id, "CLIENT", "client@example.com");
    await expect(requirePortalAccess(magicLinkToken, { artworkOrderId: orderB.id, role: "CLIENT" })).rejects.toThrow(/denied/);
  });

  it("rejects a CLIENT token used against a VENDOR-only check", async () => {
    const order = await makeArtworkOrder();
    const { magicLinkToken } = await issuePortalInvite(order.id, "CLIENT", "client@example.com");
    await expect(requirePortalAccess(magicLinkToken, { artworkOrderId: order.id, role: "VENDOR" })).rejects.toThrow(/denied/);
  });
});
