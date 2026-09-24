// Where the re-cost actually stands against the client's number.
//
// The headline is the GAP, not the saving. On Full Swing the known
// changes take about $100,000 off a $658,785 estimate against a $250,000
// target -- a real reduction, and still $300,000 short. A screen that
// leads with "you saved $100,000" while the number misses by three times
// that is worse than no screen, because it reads as progress toward a
// goal it has not approached.
//
// Two kinds of money, kept apart on purpose:
//
//   a DELTA is a change somebody has priced. The estimator's revised
//   schedule says -$61,027.51 and means it.
//
//   money AT RISK is scope whose source has died with nothing to replace
//   it yet -- the withdrawn Fuse quote's $46,830. It is NOT a saving. It
//   is an unknown, and counting it as a reduction would report hitting a
//   budget by deleting scope that is coming straight back at a price
//   nobody has quoted.
//
// A leaf module: pure functions over plain rows, no db import.

export type RecostLineStatus = "RECOSTED" | "NEEDS_RESOURCING" | "NEEDS_REVIEW" | "UNCHANGED";

export interface RecostLine {
  label: string;
  detail: string;
  status: RecostLineStatus;
  // Negative means cheaper. Null when nobody has priced the change.
  costDelta: number | null;
  // Cost sitting on a source that no longer holds. Never a saving.
  costAtRisk: number | null;
}

export interface RecostRollup {
  lines: RecostLine[];
  currentCost: number;
  currentSell: number;
  // Derived from the estimate's own totals rather than from a margin
  // percentage, so it stays true whatever per-line margins are doing.
  sellPerCost: number;
  knownCostDelta: number;
  costAtRisk: number;
  projectedSell: number;
  target: number | null;
  // Positive means still over the target. Null when no target is known.
  gap: number | null;
}

export function buildRecostRollup(input: {
  lines: RecostLine[];
  currentCost: number;
  currentSell: number;
  target: number | null;
}): RecostRollup {
  const { lines, currentCost, currentSell, target } = input;

  // A zero-cost estimate has no meaningful ratio; 1 keeps the arithmetic
  // defined and the projection honest (a delta moves sell one-for-one).
  const sellPerCost = currentCost > 0 ? currentSell / currentCost : 1;

  const knownCostDelta = lines.reduce((n, l) => n + (l.costDelta ?? 0), 0);
  const costAtRisk = lines.reduce((n, l) => n + (l.costAtRisk ?? 0), 0);

  // Only priced changes move the projection. Money at risk deliberately
  // does not -- see the header.
  const projectedSell = currentSell + knownCostDelta * sellPerCost;

  return {
    lines,
    currentCost,
    currentSell,
    sellPerCost,
    knownCostDelta,
    costAtRisk,
    projectedSell,
    target,
    gap: target === null ? null : projectedSell - target,
  };
}

// The client's number, read out of their own words.
//
// Conservative by design: it is looking for a budget someone stated, not
// for any number in a sentence. "a revised design and estimate to meet
// their budget of 250k" yields 250000; "move 3 panels" yields nothing.
// A wrong target makes every gap on the screen wrong, so ambiguity
// returns null and the screen asks instead.
export function parseTargetAmount(note: string | null | undefined): number | null {
  const text = (note ?? "").toLowerCase();
  if (!text.trim()) return null;

  // Must be anchored to a word that means "this is the number to hit".
  // Without one, a figure in a sentence is just a figure.
  const anchor = /(budget|target|come in at|get (?:it |us )?(?:to|under|down to)|no more than|cap(?:ped)? at)/;
  if (!anchor.test(text)) return null;

  const matches = [...text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b/g)];
  const values: number[] = [];
  for (const m of matches) {
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scaled = m[2] === "k" ? base * 1_000 : m[2] === "m" ? base * 1_000_000 : base;
    // A plausible exhibit budget. Rules out a date, a quantity, a
    // version number -- all of which appear in these notes.
    if (scaled >= 1_000) values.push(scaled);
  }

  if (values.length === 0) return null;
  // Two different plausible budgets in one sentence is a sentence a
  // human should read.
  const distinct = new Set(values);
  return distinct.size === 1 ? values[0] : null;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// The one sentence the screen leads with.
//
// Says the uncomfortable thing first when it is true. "Still over by" is
// the number an estimator has to act on; the reduction already achieved
// is context, not the headline.
export function rollupHeadline(r: RecostRollup): string {
  if (r.target === null) {
    return `Projected ${money(r.projectedSell)}. No target recorded for this re-cost.`;
  }
  if (r.gap !== null && r.gap > 0) {
    return `Projected ${money(r.projectedSell)} — still over by ${money(r.gap)}.`;
  }
  return `Projected ${money(r.projectedSell)} — at or under the ${money(r.target)} target.`;
}

// Where the remaining money could come from: the biggest things nobody
// has touched. Only ever suggests looking, never proposes a change --
// these are untouched precisely because an estimator decided not to
// touch them, and that decision deserves to be revisited rather than
// overridden.
export function untouchedCandidates<T extends { label: string; cost: number; status: RecostLineStatus }>(
  items: T[],
  gap: number | null,
  limit = 3,
): T[] {
  if (gap === null || gap <= 0) return [];
  return items
    .filter((i) => i.status === "UNCHANGED" && i.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit);
}
