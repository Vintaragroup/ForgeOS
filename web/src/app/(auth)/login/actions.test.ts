import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";
import { getMockCookie, resetMockCookies } from "@/test/setup";
import { loginAction } from "./actions";

beforeEach(() => {
  resetMockCookies();
});

afterEach(async () => {
  await db.rateLimitBucket.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

// loginAction always ends by throwing Next's redirect signal (there's no
// non-redirecting path), so every call site here goes through this rather
// than asserting a return value. next/navigation's redirect() throws an
// Error whose .message is just "NEXT_REDIRECT" -- the actual destination
// lives on .digest, as "NEXT_REDIRECT;<kind>;<url>;<status>;".
async function attemptLogin(fields: { email: string; password: string; next?: string }): Promise<string> {
  const formData = new FormData();
  formData.set("email", fields.email);
  formData.set("password", fields.password);
  formData.set("next", fields.next ?? "/dashboard");
  try {
    await loginAction(formData);
    throw new Error("loginAction resolved without redirecting");
  } catch (err) {
    const digest = (err as { digest?: string })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest;
    throw err;
  }
}

describe("loginAction", () => {
  it("logs in with the exact stored email and correct password", async () => {
    const email = `exact-${randomUUID()}@test.com`;
    await db.user.create({ data: { name: "Test", email, passwordHash: await hashPassword("correct horse") } });

    const result = await attemptLogin({ email, password: "correct horse", next: "/dashboard" });

    expect(result).toContain("/dashboard");
    expect(result).not.toContain("error=");
    expect(getMockCookie(SESSION_COOKIE)).toBeDefined();
  });

  // Regression test: a user typing their email with different
  // capitalization than however it was originally stored used to get
  // "Incorrect email or password" even with the exact right password --
  // see login/actions.ts's own comment for the real report that
  // uncovered this.
  it("logs in when the submitted email differs only in case from the stored email", async () => {
    const email = `Mixed.Case.${randomUUID()}@Test.com`;
    await db.user.create({ data: { name: "Test", email, passwordHash: await hashPassword("correct horse") } });

    const result = await attemptLogin({ email: email.toLowerCase(), password: "correct horse" });

    expect(result).not.toContain("error=");
    expect(getMockCookie(SESSION_COOKIE)).toBeDefined();
  });

  it("rejects an incorrect password without creating a session", async () => {
    const email = `wrongpw-${randomUUID()}@test.com`;
    await db.user.create({ data: { name: "Test", email, passwordHash: await hashPassword("correct horse") } });

    const result = await attemptLogin({ email, password: "not the password" });

    expect(result).toContain("error=1");
    expect(getMockCookie(SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects an email that doesn't exist, with the same error as a wrong password", async () => {
    const result = await attemptLogin({ email: `nobody-${randomUUID()}@test.com`, password: "anything" });

    expect(result).toContain("error=1");
    expect(getMockCookie(SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects a user with no password set yet", async () => {
    const email = `nopassword-${randomUUID()}@test.com`;
    await db.user.create({ data: { name: "Test", email } });

    const result = await attemptLogin({ email, password: "anything" });

    expect(result).toContain("error=1");
  });

  it("rejects a soft-deleted user even with the correct password", async () => {
    const email = `deleted-${randomUUID()}@test.com`;
    await db.user.create({
      data: { name: "Test", email, passwordHash: await hashPassword("correct horse"), deletedAt: new Date() },
    });

    const result = await attemptLogin({ email, password: "correct horse" });

    expect(result).toContain("error=1");
  });

  it("rate-limits repeated failed attempts against the same email", async () => {
    const email = `ratelimit-${randomUUID()}@test.com`;
    await db.user.create({ data: { name: "Test", email, passwordHash: await hashPassword("correct horse") } });

    const results: string[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await attemptLogin({ email, password: "wrong password" });
      results.push(result);
      if (result.includes("error=2")) break;
    }

    expect(results[0]).toContain("error=1");
    expect(results.some((r) => r.includes("error=2"))).toBe(true);
  });
});
