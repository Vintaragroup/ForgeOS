import { describe, expect, it } from "vitest";
import { ageLabel, agingBucket, daysSince, isStale } from "@/lib/contact-aging";

const NOW = new Date("2026-09-19T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("agingBucket", () => {
  it("buckets at the agreed 30 / 90 / 180 / 365 boundaries, inclusive", () => {
    expect(agingBucket(daysAgo(0), NOW).key).toBe("recent");
    expect(agingBucket(daysAgo(30), NOW).key).toBe("recent");
    expect(agingBucket(daysAgo(31), NOW).key).toBe("warm");
    expect(agingBucket(daysAgo(90), NOW).key).toBe("warm");
    expect(agingBucket(daysAgo(91), NOW).key).toBe("cooling");
    expect(agingBucket(daysAgo(180), NOW).key).toBe("cooling");
    expect(agingBucket(daysAgo(181), NOW).key).toBe("cold");
    expect(agingBucket(daysAgo(365), NOW).key).toBe("cold");
    expect(agingBucket(daysAgo(366), NOW).key).toBe("dormant");
  });

  it("treats a missing date as its own 'no record' bucket, and a future date as current", () => {
    expect(agingBucket(null, NOW)).toMatchObject({ key: "never", tone: "neutral" });
    expect(agingBucket(new Date("2027-01-20T00:00:00Z"), NOW).key).toBe("recent");
    expect(daysSince(new Date("2027-01-20T00:00:00Z"), NOW)).toBe(0);
  });
});

describe("ageLabel / isStale", () => {
  it("reads naturally at each scale", () => {
    expect(ageLabel(null, NOW)).toBe("Never");
    expect(ageLabel(daysAgo(0), NOW)).toBe("Today");
    expect(ageLabel(daysAgo(1), NOW)).toBe("1 day ago");
    expect(ageLabel(daysAgo(45), NOW)).toBe("45 days ago");
    expect(ageLabel(daysAgo(200), NOW)).toBe("6 months ago");
    expect(ageLabel(daysAgo(800), NOW)).toBe("2 years ago");
  });

  it("counts never-contacted as stale", () => {
    expect(isStale(null, 90, NOW)).toBe(true);
    expect(isStale(daysAgo(89), 90, NOW)).toBe(false);
    expect(isStale(daysAgo(90), 90, NOW)).toBe(true);
  });
});
