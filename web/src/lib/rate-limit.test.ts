import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit";

afterEach(async () => {
  await db.rateLimitBucket.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("checkRateLimit", () => {
  it("allows calls up to the limit, then throws RateLimitError", async () => {
    const key = `test:${randomUUID()}`;

    for (let i = 0; i < 5; i++) {
      await expect(checkRateLimit(key, 5, 60_000)).resolves.toBeUndefined();
    }

    await expect(checkRateLimit(key, 5, 60_000)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("resets the count once the window has expired", async () => {
    const key = `test:${randomUUID()}`;

    for (let i = 0; i < 3; i++) {
      await checkRateLimit(key, 3, 60_000);
    }
    await expect(checkRateLimit(key, 3, 60_000)).rejects.toBeInstanceOf(RateLimitError);

    // Simulate the window having already elapsed rather than sleeping in
    // the test -- checkRateLimit only cares whether resetAt is in the past.
    await db.rateLimitBucket.update({ where: { key }, data: { resetAt: new Date(Date.now() - 1000) } });

    await expect(checkRateLimit(key, 3, 60_000)).resolves.toBeUndefined();
    const bucket = await db.rateLimitBucket.findUniqueOrThrow({ where: { key } });
    expect(bucket.count).toBe(1);
  });

  it("increments atomically under concurrent calls -- no lost updates", async () => {
    const key = `test:${randomUUID()}`;
    const limit = 50;

    // 20 calls fired concurrently against a fresh key -- a naive
    // read-modify-write would undercount and let more than `limit`
    // through; the atomic `{ count: { increment: 1 } }` update must not.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => checkRateLimit(key, limit, 60_000)),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const bucket = await db.rateLimitBucket.findUniqueOrThrow({ where: { key } });
    expect(bucket.count).toBe(20);
  });
});
