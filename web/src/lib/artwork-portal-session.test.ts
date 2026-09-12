import { describe, expect, it } from "vitest";
import { hashInviteToken, timingSafeHashEquals } from "@/lib/artwork-portal-session";

describe("hashInviteToken / timingSafeHashEquals", () => {
  it("produces the same hash for the same raw token", () => {
    expect(hashInviteToken("raw-token-abc")).toBe(hashInviteToken("raw-token-abc"));
  });

  it("produces a different hash for a different raw token", () => {
    expect(hashInviteToken("raw-token-abc")).not.toBe(hashInviteToken("raw-token-xyz"));
  });

  it("timingSafeHashEquals matches equal hashes and rejects unequal ones", () => {
    const hash = hashInviteToken("raw-token-abc");
    expect(timingSafeHashEquals(hash, hashInviteToken("raw-token-abc"))).toBe(true);
    expect(timingSafeHashEquals(hash, hashInviteToken("raw-token-xyz"))).toBe(false);
  });
});
