// Aging for "last contacted" and "last worked with" -- how long it's been,
// bucketed so a list can be scanned by color. Buckets agreed with the user
// (2026-09-19): 0-30 / 31-90 / 91-180 / 181-365 / 365+ days, which fits a
// trade-show cycle where many clients buy once or twice a year.
//
// Pure functions only (no db) so every page -- companies, contacts, the
// dashboard, the Salesmate admin page -- buckets identically.

export type AgingBucketKey = "recent" | "warm" | "cooling" | "cold" | "dormant" | "never";

export interface AgingBucket {
  key: AgingBucketKey;
  label: string;
  // StatusChip tones (components/ui.tsx).
  tone: "good" | "info" | "warning" | "critical" | "neutral";
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const AGING_BUCKETS: readonly (AgingBucket & { maxDays: number })[] = [
  { key: "recent", label: "0–30 days", tone: "good", maxDays: 30 },
  { key: "warm", label: "31–90 days", tone: "info", maxDays: 90 },
  { key: "cooling", label: "91–180 days", tone: "warning", maxDays: 180 },
  { key: "cold", label: "181–365 days", tone: "critical", maxDays: 365 },
  { key: "dormant", label: "365+ days", tone: "critical", maxDays: Infinity },
];

export const NEVER_BUCKET: AgingBucket = { key: "never", label: "No record", tone: "neutral" };

// Whole days elapsed, never negative (a future date -- e.g. an upcoming
// show's end date -- counts as 0, "current").
export function daysSince(date: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}

export function agingBucket(date: Date | null | undefined, now: Date = new Date()): AgingBucket {
  if (!date) return NEVER_BUCKET;
  const days = daysSince(date, now);
  const bucket = AGING_BUCKETS.find((b) => days <= b.maxDays)!;
  return { key: bucket.key, label: bucket.label, tone: bucket.tone };
}

// "Today", "1 day ago", "45 days ago", "14 months ago" -- a short human
// age for a chip, next to the exact date.
export function ageLabel(date: Date | null | undefined, now: Date = new Date()): string {
  if (!date) return "Never";
  const days = daysSince(date, now);
  if (days === 0) return "Today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365.25);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

// The URL filter values used by the company/contact lists' "not contacted
// in N+ days" filter.
export const STALE_FILTER_DAYS = [30, 90, 180, 365] as const;

export function isStale(date: Date | null | undefined, minDays: number, now: Date = new Date()): boolean {
  return !date || daysSince(date, now) >= minDays;
}
