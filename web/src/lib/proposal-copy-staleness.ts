// Whether a written scope summary still describes what it was written
// about.
//
// These summaries are generated from line-item DESCRIPTIONS and nothing
// else (ai/section-description-service.ts), so they go stale exactly when
// those descriptions change -- a row removed, added, or reworded. On ABC
// Chicago a booth summary describing "a large LED screen measuring 8 feet
// high by over 11 feet wide" survived the section being cut down to one
// row reading '60" LED monitors attached to areas of the exhibit', and
// nothing anywhere said so. It was still being printed for a client.
//
// Deliberately keyed on descriptions alone. A price or quantity change
// does not make the sentence wrong, and flagging on any edit would train
// people to ignore the flag -- which is the failure mode that matters,
// because a warning nobody reads is worse than none.
//
// A leaf module: pure functions over plain strings, no db import.

// Order-independent and whitespace-tolerant: reordering rows or fixing
// spacing does not change what the booth IS.
export function summarySourceKey(descriptions: string[]): string {
  return descriptions
    .map((d) => d.toLowerCase().replace(/\s+/g, " ").trim())
    .filter((d) => d.length > 0)
    .sort()
    .join("|");
}

// A summary with no key recorded predates this check. Reported as
// UNKNOWN rather than stale: it may be perfectly current, and crying
// wolf over every summary written before today would bury the two that
// are genuinely wrong.
export type CopyState = "CURRENT" | "STALE" | "UNKNOWN" | "NONE";

export function copyState(input: {
  summary: string | null | undefined;
  recordedKey: string | null | undefined;
  currentDescriptions: string[];
}): CopyState {
  if (!input.summary) return "NONE";
  if (!input.recordedKey) return "UNKNOWN";
  return input.recordedKey === summarySourceKey(input.currentDescriptions) ? "CURRENT" : "STALE";
}

export function copyStateLabel(state: CopyState): string | null {
  switch (state) {
    case "STALE":
      // Says what changed and what to do, because "stale" alone invites
      // someone to approve whatever is there to make the badge go away.
      return "The line items under this changed after this text was written — regenerate it";
    case "UNKNOWN":
    case "CURRENT":
    case "NONE":
      return null;
  }
}
