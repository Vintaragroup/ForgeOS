// What the estimator wrote next to each element on the revised
// spreadsheet.
//
// This is the primary source for a re-cost and it beats every inference
// the rest of this feature makes. Full Swing's revised workbook carries a
// status against every row, initialled and dated:
//
//   FS - Hitting Bay Wall     43,849 -> 19,202   Updated 091826 TA
//   FS - Diamond Sign 5'4      2,508 ->      0   Eliminated 091827 TA
//   FS - Reception Counter     7,469 ->      0   Eliminated 091827 TA
//   FS - Lit Spines (Lounge)  37,281 -> 37,281   No change 091827 TA
//
// A vision model looking at renderings is guessing at what that sentence
// states outright. So the review reads this rather than re-deriving it,
// and the drawing comparison's job shrinks to corroborating it and
// covering what it does not reach.
//
// A leaf module: pure functions over plain rows, no db import.

export type RecostStatusKind = "UPDATED" | "ELIMINATED" | "NO_CHANGE" | "UNRECOGNISED";

export interface ParsedStatus {
  kind: RecostStatusKind;
  // Kept whole so a proposal can quote it verbatim -- the citation
  // requirement applies here as much as anywhere, and "Eliminated 091827
  // TA" is a better citation than "eliminated".
  raw: string;
  // Who and when, when the note carries them. Not required: a status
  // still means something unsigned, it is just weaker evidence.
  initials: string | null;
  dateCode: string | null;
}

const KINDS: [RegExp, RecostStatusKind][] = [
  // "No change", "No  change" (the real file has a double space), "nochange"
  [/\bno\s*change\b/i, "NO_CHANGE"],
  [/\beliminat/i, "ELIMINATED"],
  [/\bupdate/i, "UPDATED"],
  [/\brevis/i, "UPDATED"],
  [/\bremove/i, "ELIMINATED"],
];

export function parseRecostStatus(raw: string | null | undefined): ParsedStatus {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "UNRECOGNISED", raw: "", initials: null, dateCode: null };

  const kind = KINDS.find(([re]) => re.test(text))?.[1] ?? "UNRECOGNISED";

  // A 6-digit MMDDYY stamp, and trailing initials. Both optional.
  const dateCode = text.match(/\b(\d{6})\b/)?.[1] ?? null;
  const initials = text.match(/\b([A-Z]{2,3})\s*$/)?.[1] ?? null;

  return { kind, raw: text, initials, dateCode };
}

export interface SummaryRow {
  client: string;
  element: string;
  total: number;
  status: string | null;
}

export type ElementAction = "REMOVE" | "REPRICE" | "NONE" | "ADD" | "REVIEW";

export interface ElementChange {
  element: string;
  previousTotal: number | null;
  currentTotal: number | null;
  // Negative means cheaper. Null when one side is missing entirely.
  delta: number | null;
  status: ParsedStatus;
  action: ElementAction;
  // Set when the written status and the numbers disagree. Not resolved
  // here -- a human decides which is right.
  discrepancy: string | null;
}

function normalize(element: string): string {
  return element.toLowerCase().replace(/\s+/g, " ").trim();
}

// Pairs the two summaries by element name and reconciles what the status
// says against what the numbers do.
//
// Paired on element, never on client: Full Swing's revised workbook
// re-labels every row's client to "Full Swing" while keeping element
// names like "Second Swing - Lounge Wall Structure". Pairing on client
// would lose those rows entirely.
export function pairSummaryRows(previous: SummaryRow[], current: SummaryRow[]): ElementChange[] {
  const before = new Map(previous.map((r) => [normalize(r.element), r]));
  const seen = new Set<string>();
  const out: ElementChange[] = [];

  for (const row of current) {
    const key = normalize(row.element);
    seen.add(key);
    const prior = before.get(key);
    const status = parseRecostStatus(row.status);
    const previousTotal = prior?.total ?? null;
    const delta = previousTotal === null ? null : row.total - previousTotal;

    out.push({
      element: row.element,
      previousTotal,
      currentTotal: row.total,
      delta,
      status,
      action: actionFor(status.kind, previousTotal, row.total),
      discrepancy: discrepancyFor(status.kind, previousTotal, row.total),
    });
  }

  // On the old summary and not the new one at all. Not the same as
  // "Eliminated", which is a decision someone recorded -- this is a row
  // that simply vanished, which is worth asking about rather than
  // assuming either way.
  for (const row of previous) {
    if (seen.has(normalize(row.element))) continue;
    out.push({
      element: row.element,
      previousTotal: row.total,
      currentTotal: null,
      delta: null,
      status: parseRecostStatus(null),
      action: "REVIEW",
      discrepancy: "On the previous summary and missing from the revised one, with no status recorded.",
    });
  }

  // Biggest saving first: on a job being cut to a budget that is the
  // order the decisions get made in.
  return out.sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));
}

function actionFor(kind: RecostStatusKind, previousTotal: number | null, currentTotal: number): ElementAction {
  if (previousTotal === null) return "ADD";
  switch (kind) {
    case "ELIMINATED":
      return "REMOVE";
    case "NO_CHANGE":
      return "NONE";
    case "UPDATED":
      return "REPRICE";
    case "UNRECOGNISED":
      // No status written. The numbers are still evidence, but weaker --
      // nobody said this was deliberate.
      return currentTotal === previousTotal ? "NONE" : "REVIEW";
  }
}

// The status and the arithmetic should agree. When they do not, neither
// is silently preferred: an estimator wrote one and calculated the other,
// and which is stale is not something to guess at.
function discrepancyFor(kind: RecostStatusKind, previousTotal: number | null, currentTotal: number): string | null {
  if (previousTotal === null) return null;

  if (kind === "ELIMINATED" && currentTotal !== 0) {
    return `Marked eliminated but still carries ${currentTotal.toFixed(2)}.`;
  }
  if (kind === "NO_CHANGE" && currentTotal !== previousTotal) {
    return `Marked no change but the total moved by ${(currentTotal - previousTotal).toFixed(2)}.`;
  }
  if (kind === "UPDATED" && currentTotal === previousTotal) {
    return "Marked updated but the total is unchanged.";
  }
  return null;
}

export interface RecostSummary {
  changes: ElementChange[];
  previousTotal: number;
  currentTotal: number;
  delta: number;
  eliminatedCount: number;
  repricedCount: number;
  unchangedCount: number;
  needsReviewCount: number;
}

export function summariseChanges(changes: ElementChange[]): RecostSummary {
  const previousTotal = changes.reduce((n, c) => n + (c.previousTotal ?? 0), 0);
  const currentTotal = changes.reduce((n, c) => n + (c.currentTotal ?? 0), 0);
  return {
    changes,
    previousTotal,
    currentTotal,
    delta: currentTotal - previousTotal,
    eliminatedCount: changes.filter((c) => c.action === "REMOVE").length,
    repricedCount: changes.filter((c) => c.action === "REPRICE").length,
    unchangedCount: changes.filter((c) => c.action === "NONE").length,
    // Anything a person has to look at: no status, a vanished row, or a
    // status that disagrees with the numbers.
    needsReviewCount: changes.filter((c) => c.action === "REVIEW" || c.discrepancy).length,
  };
}
