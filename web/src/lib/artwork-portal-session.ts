import { createHash, timingSafeEqual } from "node:crypto";

// Pure crypto for the artwork pipeline's magic-link portal tokens. Unlike
// session.ts's internal session cookie, there is no signed session-cookie
// format here at all -- see artwork-portal-auth.ts's header comment for
// why (a durable bearer link for the whole order lifecycle, not a one-shot
// login exchanged for a cookie). This file just hashes/compares the raw
// token; artwork-portal-auth.ts owns everything DB-related.

export type ArtworkPortalRole = "CLIENT" | "VENDOR";

export interface PortalIdentity {
  artworkOrderId: string;
  role: ArtworkPortalRole;
  email: string;
}

export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function timingSafeHashEquals(hashA: string, hashB: string): boolean {
  const bufA = Buffer.from(hashA);
  const bufB = Buffer.from(hashB);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
