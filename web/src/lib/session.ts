import { randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";

// Pure crypto helpers, no Next.js or Prisma imports -- proxy.ts (which runs
// on every request) imports only this file, not src/lib/auth.ts, so it
// never pulls in a Prisma client just to check a cookie's signature.

const scryptAsync = promisify(scrypt);
export const SESSION_COOKIE = "forgeos_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set -- see .env.example");
  return secret;
}

// scrypt, not bcrypt -- Node's built-in crypto module, so this needs no new
// dependency (keeps the same lean-footprint approach as the engine-less
// Prisma 7 client). Stored as "saltHex:hashHex".
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

// Item #7 of the security/hardening roadmap: passwordChangedAt is
// embedded as a THIRD signed claim (not just userId + expiresAt) so a
// session issued before the user's password was last changed can be
// rejected later, without needing a server-side session store -- see
// auth.ts's getCurrentUser for the actual comparison (this file stays
// DB-free on purpose, see the header comment above). null (never
// explicitly changed) is encoded as 0, distinguishable from any real
// timestamp (which is always > 0).
export function buildSessionValue(userId: string, passwordChangedAt: Date | null): string {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}.${passwordChangedAt ? passwordChangedAt.getTime() : 0}`;
  return `${payload}.${sign(payload)}`;
}

export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

export function parseSessionValue(value: string | undefined): { userId: string; passwordChangedAtMs: number } | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [userId, expiresAtStr, passwordChangedAtStr, signature] = parts;
  const payload = `${userId}.${expiresAtStr}.${passwordChangedAtStr}`;
  const expected = sign(payload);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const passwordChangedAtMs = Number(passwordChangedAtStr);
  if (!Number.isFinite(passwordChangedAtMs)) return null;
  return { userId, passwordChangedAtMs };
}

// Pure comparison, deliberately pulled out of auth.ts's getCurrentUser
// (which needs a real Next.js request context via cookies() to reach at
// all) so this specific security-critical check -- get it wrong either
// direction and it either locks out every legitimate session or revokes
// nothing -- is directly unit-testable on its own. null passwordChangedAt
// (a user row that predates this column, or one that's never explicitly
// changed its password) never counts as stale.
export function isSessionStale(
  session: { passwordChangedAtMs: number },
  user: { passwordChangedAt: Date | null },
): boolean {
  return user.passwordChangedAt != null && session.passwordChangedAtMs < user.passwordChangedAt.getTime();
}
