import { db } from "@/lib/db";

// Postgres-backed, fixed-window rate limiter -- swapped from the old
// in-memory Map once ForgeOS moved to serverless (Vercel): every invocation
// can be a cold-started, stateless container, so the shared bucket has to
// live in the database. Expired rows are simply overwritten by the next
// call -- no separate sweep needed at this table's expected size.

export class RateLimitError extends Error {
  constructor(message = "Too many attempts. Please wait a few minutes and try again.") {
    super(message);
    this.name = "RateLimitError";
  }
}

// Throws RateLimitError once `key` has been called more than `limit` times
// within the current `windowMs` window.
//
// A separate findUnique-then-upsert (read, branch, write) leaves a race on
// a key's *first* call: two concurrent requests can both read "no bucket
// yet" before either write commits, so both take the create branch and
// each set count back to 1 -- undercounting under real concurrent load,
// exactly the failure mode this table exists to avoid. A single
// INSERT ... ON CONFLICT statement closes that gap: Postgres serializes
// concurrent upserts against the same key via row-level locking, so the
// count/resetAt decision and the write happen atomically together.
//
// `now` is passed in as a parameter rather than using SQL now() -- resetAt
// is a naive TIMESTAMP(3) column holding UTC instants (how Prisma writes
// DateTime), but now() is evaluated in the DB session's local timezone;
// comparing the two directly is wrong whenever that session isn't UTC.
// Binding a JS Date as a parameter sidesteps the ambiguity entirely.
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_buckets (key, count, "resetAt")
    VALUES (${key}, 1, ${resetAt})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limit_buckets."resetAt" < ${now} THEN 1 ELSE rate_limit_buckets.count + 1 END,
      "resetAt" = CASE WHEN rate_limit_buckets."resetAt" < ${now} THEN ${resetAt} ELSE rate_limit_buckets."resetAt" END
    RETURNING count
  `;
  if (rows[0].count > limit) {
    throw new RateLimitError();
  }
}
