import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import type { ArtworkPortalRole } from "@/generated/prisma/enums";
import { hashInviteToken, timingSafeHashEquals, type PortalIdentity } from "@/lib/artwork-portal-session";

export type { PortalIdentity };

// A pipeline order can run for weeks (submission -> review -> proof rounds
// -> production -> ship), and the client/vendor need to revisit the SAME
// emailed link the whole time from potentially different devices -- this is
// a durable bearer capability for one ArtworkOrder, not a one-shot
// passwordless-login link. So, deliberately UNLIKE a typical magic-link
// flow: the token is never marked single-use, and there is no separate
// session-cookie exchange step -- every portal page/action just validates
// the token straight from the URL on every request (mirrors how internal
// Server Actions call requireOpportunityAccess themselves each time rather
// than trusting a prior check). Expo can still kill a link early via
// ArtworkPortalInvite.revokedAt if one leaks.
const INVITE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function issuePortalInvite(artworkOrderId: string, role: ArtworkPortalRole, email: string) {
  const rawToken = randomBytes(32).toString("hex");
  const invite = await db.artworkPortalInvite.create({
    data: {
      artworkOrderId,
      role,
      email,
      tokenHash: hashInviteToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  // The magic link itself: "<inviteId>:<rawToken>". Only tokenHash is ever
  // persisted -- a DB leak alone can't be used to forge a valid link.
  return { invite, magicLinkToken: `${invite.id}:${rawToken}` };
}

// The one function every portal page/action calls to authenticate a
// request -- directly unit-testable, no Next.js request context needed
// (no cookies(), unlike session.ts's internal counterpart), since the
// token travels in the URL rather than a cookie. usedAt is set on first
// validation purely as an informational "first opened at" timestamp; it is
// NOT a single-use gate and never causes a later, otherwise-valid call to
// fail.
export async function validatePortalToken(magicLinkToken: string): Promise<PortalIdentity | null> {
  // Next's dynamic route params for this app/version do NOT get
  // percent-decoded before reaching the page/route handler, so a token
  // straight from a [token] segment still has its ":" delimiter as
  // "%3A" -- decoding here (a no-op for an already-decoded string, e.g.
  // one passed straight from a bound Server Action closure rather than
  // freshly read from params) makes every caller work regardless of
  // which shape it received.
  const [inviteId, rawToken] = decodeURIComponent(magicLinkToken).split(":");
  if (!inviteId || !rawToken) return null;

  const invite = await db.artworkPortalInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.revokedAt || invite.expiresAt < new Date()) return null;
  if (!timingSafeHashEquals(invite.tokenHash, hashInviteToken(rawToken))) return null;

  if (!invite.usedAt) {
    await db.artworkPortalInvite.update({ where: { id: invite.id }, data: { usedAt: new Date() } });
  }
  return { artworkOrderId: invite.artworkOrderId, role: invite.role, email: invite.email };
}

// The portal equivalent of requireOpportunityAccess: every portal
// route/action calls this with the specific ArtworkOrder + role it
// expects, since a valid token for one order/role must never authorize
// another -- there is no admin-style bypass here, unlike internal access
// checks, because there is no "internal" tier in this identity at all.
// Throws (rather than returning null) so callers can treat it exactly like
// requireOpportunityAccess -- let it throw, don't handle per-call.
export async function requirePortalAccess(
  magicLinkToken: string,
  expected: { artworkOrderId: string; role: ArtworkPortalRole },
): Promise<PortalIdentity> {
  const identity = await validatePortalToken(magicLinkToken);
  if (!identity || identity.artworkOrderId !== expected.artworkOrderId || identity.role !== expected.role) {
    throw new Error("Portal access denied.");
  }
  return identity;
}
