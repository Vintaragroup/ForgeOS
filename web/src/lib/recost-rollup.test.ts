import { describe, expect, it } from "vitest";
import {
  buildRecostRollup,
  parseTargetAmount,
  rollupHeadline,
  untouchedCandidates,
  type RecostLine,
} from "@/lib/recost-rollup";

// Full Swing's real numbers.
const CURRENT_COST = 399486.24;
const CURRENT_SELL = 658785.1;

function line(over: Partial<RecostLine>): RecostLine {
  return { label: "x", detail: "", status: "RECOSTED", costDelta: null, costAtRisk: null, ...over };
}

describe("buildRecostRollup", () => {
  it("converts a cost delta to sell using the estimate's own ratio", () => {
    const r = buildRecostRollup({
      lines: [line({ label: "fabrication", costDelta: -61027.51 })],
      currentCost: CURRENT_COST,
      currentSell: CURRENT_SELL,
      target: 250000,
    });

    // 658,785 / 399,486 = 1.649, so -61,028 of cost is about -100,600
    // of sell. Derived from the totals rather than a margin percentage,
    // which keeps it true whatever per-line margins do.
    expect(r.sellPerCost).toBeCloseTo(1.649, 3);
    expect(r.projectedSell).toBeCloseTo(558145.8, 1);
    expect(r.gap).toBeCloseTo(308145.8, 1);
  });

  // The rule the whole module exists for: money on a dead source is an
  // unknown, not a reduction. Counting it would report hitting the
  // budget by deleting scope that is coming straight back unpriced.
  it("never lets money at risk move the projection", () => {
    const withRisk = buildRecostRollup({
      lines: [line({ label: "AV", status: "NEEDS_RESOURCING", costAtRisk: 46830 })],
      currentCost: CURRENT_COST,
      currentSell: CURRENT_SELL,
      target: 250000,
    });

    expect(withRisk.costAtRisk).toBe(46830);
    expect(withRisk.knownCostDelta).toBe(0);
    expect(withRisk.projectedSell).toBeCloseTo(CURRENT_SELL, 2);
  });

  it("sums deltas and risk separately across lines", () => {
    const r = buildRecostRollup({
      lines: [
        line({ label: "fabrication", costDelta: -61027.51 }),
        line({ label: "AV", status: "NEEDS_RESOURCING", costAtRisk: 46830 }),
        line({ label: "sign", costDelta: -42943 }),
      ],
      currentCost: CURRENT_COST,
      currentSell: CURRENT_SELL,
      target: 250000,
    });
    expect(r.knownCostDelta).toBeCloseTo(-103970.51, 2);
    expect(r.costAtRisk).toBe(46830);
  });

  it("reports no gap when no target is known", () => {
    const r = buildRecostRollup({ lines: [], currentCost: CURRENT_COST, currentSell: CURRENT_SELL, target: null });
    expect(r.gap).toBeNull();
  });

  it("survives an estimate with no cost on it", () => {
    const r = buildRecostRollup({ lines: [], currentCost: 0, currentSell: 0, target: 1000 });
    expect(r.sellPerCost).toBe(1);
    expect(r.projectedSell).toBe(0);
  });
});

describe("rollupHeadline", () => {
  const base = { lines: [], currentCost: CURRENT_COST, currentSell: CURRENT_SELL };

  // Says the uncomfortable thing first when it is true.
  it("leads with how far over it still is", () => {
    const r = buildRecostRollup({ ...base, lines: [line({ costDelta: -61027.51 })], target: 250000 });
    expect(rollupHeadline(r)).toMatch(/still over by/);
    expect(rollupHeadline(r)).toMatch(/\$308,1/);
  });

  it("says so plainly when the target is met", () => {
    const r = buildRecostRollup({ ...base, lines: [line({ costDelta: -350000 })], target: 250000 });
    expect(rollupHeadline(r)).toMatch(/at or under/);
  });

  it("does not invent a gap with no target", () => {
    const r = buildRecostRollup({ ...base, target: null });
    expect(rollupHeadline(r)).toMatch(/No target recorded/);
  });
});

describe("parseTargetAmount", () => {
  // The client's actual words on this job.
  it("reads a stated budget", () => {
    expect(parseTargetAmount("client requested a revised design and estimate to meet their budget of 250k")).toBe(
      250000,
    );
  });

  it("handles the ways people write it", () => {
    expect(parseTargetAmount("needs to come in at $250,000")).toBe(250000);
    expect(parseTargetAmount("target 1.2m")).toBe(1200000);
    expect(parseTargetAmount("get it under 300k")).toBe(300000);
  });

  // A figure in a sentence is not a budget. A wrong target makes every
  // gap on the screen wrong, so this refuses far more than it accepts.
  it("ignores numbers that are not a stated budget", () => {
    expect(parseTargetAmount("move 3 panels and reprice the 55000 sq ft of turf")).toBeNull();
    expect(parseTargetAmount("client wants the 90x20 revised")).toBeNull();
    expect(parseTargetAmount("")).toBeNull();
    expect(parseTargetAmount(null)).toBeNull();
  });

  it("refuses when two different budgets are stated", () => {
    expect(parseTargetAmount("budget was 300k, now target 250k")).toBeNull();
  });

  it("accepts the same figure stated twice", () => {
    expect(parseTargetAmount("budget of 250000, so target 250000")).toBe(250000);
  });

  // Rules out dates, quantities and version numbers, which all appear
  // in these notes.
  it("ignores figures too small to be an exhibit budget", () => {
    expect(parseTargetAmount("budget discussion on 24 September, v2")).toBeNull();
  });
});

describe("untouchedCandidates", () => {
  // Full Swing's two "No change" elements -- $85,079 between them, and
  // the only place left with enough in it to close the gap.
  const items = [
    { label: "FS - Lit Angled Spines (Lounge)", cost: 37280.6, status: "UNCHANGED" as const },
    { label: "SS - Lounge Wall Structure", cost: 47797.91, status: "UNCHANGED" as const },
    { label: "FS - Hitting Bay Wall", cost: 19202.35, status: "RECOSTED" as const },
  ];

  it("names the biggest untouched items when still over", () => {
    const out = untouchedCandidates(items, 308145);
    expect(out.map((i) => i.label)).toEqual([
      "SS - Lounge Wall Structure",
      "FS - Lit Angled Spines (Lounge)",
    ]);
  });

  // Nothing to suggest when the target is met -- and nothing to suggest
  // when there is no target to be over.
  it("suggests nothing when the gap is closed or unknown", () => {
    expect(untouchedCandidates(items, 0)).toEqual([]);
    expect(untouchedCandidates(items, -5000)).toEqual([]);
    expect(untouchedCandidates(items, null)).toEqual([]);
  });

  it("never suggests something already re-costed", () => {
    expect(untouchedCandidates(items, 100000).every((i) => i.status === "UNCHANGED")).toBe(true);
  });
});
