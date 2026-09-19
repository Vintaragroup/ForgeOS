import { StatusChip } from "@/components/ui";
import { ageLabel, agingBucket } from "@/lib/contact-aging";

// "45 days ago", colored by aging bucket (contact-aging.ts) -- the same
// chip for last-contacted and last-worked-with everywhere they appear.
// The exact date rides along as a tooltip (UTC date, so server and
// browser agree).
export function AgingChip({ date, emptyLabel = "Never" }: { date: Date | null | undefined; emptyLabel?: string }) {
  const bucket = agingBucket(date);
  return (
    <span title={date ? date.toISOString().slice(0, 10) : undefined}>
      <StatusChip tone={bucket.tone}>{date ? ageLabel(date) : emptyLabel}</StatusChip>
    </span>
  );
}
