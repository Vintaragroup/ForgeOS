// B20: in-memory, fixed-window rate limiter -- single-instance only, which
// matches how ForgeOS actually runs today (no deploy target chosen yet, see
// backlog B3). Swap the Map for a shared store (Redis, etc.) if this ever
// runs multi-instance; the call sites wouldn't need to change.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Sweep occasionally so the map doesn't grow forever in a long-running
// process -- cheap and approximate, not a precise LRU.
let lastSweep = Date.now();
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export class RateLimitError extends Error {
  constructor(message = "Too many attempts. Please wait a few minutes and try again.") {
    super(message);
    this.name = "RateLimitError";
  }
}

// Throws RateLimitError once `key` has been called more than `limit` times
// within the current `windowMs` window.
export function checkRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new RateLimitError();
  }
}
