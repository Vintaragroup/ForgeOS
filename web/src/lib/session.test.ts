import { describe, expect, it } from "vitest";
import {
  buildSessionValue,
  hashPassword,
  isSessionStale,
  parseSessionValue,
  verifyPassword,
} from "@/lib/session";

describe("hashPassword / verifyPassword", () => {
  it("round-trips a password through hash then verify", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("rejects a malformed stored hash rather than throwing", async () => {
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
  });
});

describe("buildSessionValue / parseSessionValue", () => {
  it("round-trips a valid session with a real passwordChangedAt", () => {
    const changedAt = new Date("2026-01-01T00:00:00.000Z");
    const value = buildSessionValue("user-1", changedAt);
    const parsed = parseSessionValue(value);
    expect(parsed).toEqual({ userId: "user-1", passwordChangedAtMs: changedAt.getTime() });
  });

  it("round-trips a valid session with a null passwordChangedAt as 0", () => {
    const value = buildSessionValue("user-1", null);
    const parsed = parseSessionValue(value);
    expect(parsed).toEqual({ userId: "user-1", passwordChangedAtMs: 0 });
  });

  it("returns null for an undefined cookie value", () => {
    expect(parseSessionValue(undefined)).toBeNull();
  });

  it("returns null for a value with the wrong number of segments (old 3-part pre-#7 format)", () => {
    // A session cookie issued before this claim existed -- rejecting it
    // (forcing a re-login) rather than trying to parse it as if it had
    // the new shape is the correct, safe failure mode.
    expect(parseSessionValue("user-1.9999999999999.somesignature")).toBeNull();
  });

  it("returns null when the signature doesn't match the payload", () => {
    const value = buildSessionValue("user-1", null);
    const [userId, expiresAt, changedAt] = value.split(".");
    const tampered = `${userId}.${expiresAt}.${changedAt}.tamperedsignature`;
    expect(parseSessionValue(tampered)).toBeNull();
  });

  it("returns null when the passwordChangedAt segment is tampered with (signature no longer matches)", () => {
    const value = buildSessionValue("user-1", null);
    const [userId, expiresAt, , signature] = value.split(".");
    // Attacker tries to forge an older passwordChangedAt claim to survive
    // a real password change -- the signature was computed over the
    // ORIGINAL payload, so this must fail exactly like any other tamper.
    const tampered = `${userId}.${expiresAt}.123.${signature}`;
    expect(parseSessionValue(tampered)).toBeNull();
  });

  it("returns null for an expired session", () => {
    const value = buildSessionValue("user-1", null);
    const [userId, , changedAt] = value.split(".");
    const expiredPayload = `${userId}.1.${changedAt}`;
    // Can't forge a valid signature for the tampered expiry without the
    // real secret, so this also proves an attacker can't extend their
    // own session's expiry either -- same tamper-detection path.
    expect(parseSessionValue(`${expiredPayload}.fakesignature`)).toBeNull();
  });
});

describe("isSessionStale", () => {
  it("is not stale when the user has never explicitly changed their password (null)", () => {
    expect(isSessionStale({ passwordChangedAtMs: 0 }, { passwordChangedAt: null })).toBe(false);
  });

  it("is stale when the session was issued strictly before the user's current passwordChangedAt", () => {
    const changedAt = new Date("2026-06-01T00:00:00.000Z");
    const sessionIssuedBefore = { passwordChangedAtMs: changedAt.getTime() - 1000 };
    expect(isSessionStale(sessionIssuedBefore, { passwordChangedAt: changedAt })).toBe(true);
  });

  it("is NOT stale when the session was issued at exactly the current passwordChangedAt (the session created right after the change itself)", () => {
    const changedAt = new Date("2026-06-01T00:00:00.000Z");
    const sessionIssuedAtChange = { passwordChangedAtMs: changedAt.getTime() };
    expect(isSessionStale(sessionIssuedAtChange, { passwordChangedAt: changedAt })).toBe(false);
  });

  it("is not stale when the session was issued after the user's current passwordChangedAt", () => {
    const changedAt = new Date("2026-06-01T00:00:00.000Z");
    const sessionIssuedAfter = { passwordChangedAtMs: changedAt.getTime() + 1000 };
    expect(isSessionStale(sessionIssuedAfter, { passwordChangedAt: changedAt })).toBe(false);
  });
});
