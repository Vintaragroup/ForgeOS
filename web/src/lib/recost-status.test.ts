import { describe, expect, it } from "vitest";
import {
  pairSummaryRows,
  parseRecostStatus,
  summariseChanges,
  type SummaryRow,
} from "@/lib/recost-status";

describe("parseRecostStatus", () => {
  // Verbatim from Full Swing's revised workbook, including the double
  // space in "No  change" that the real file carries.
  it("reads the statuses the estimator actually writes", () => {
    expect(parseRecostStatus("Updated 091826 TA").kind).toBe("UPDATED");
    expect(parseRecostStatus("Eliminated 091827 TA").kind).toBe("ELIMINATED");
    expect(parseRecostStatus("No  change 091827 TA").kind).toBe("NO_CHANGE");
  });

  it("keeps the note whole so a proposal can quote it", () => {
    const s = parseRecostStatus("Eliminated 091827 TA");
    expect(s.raw).toBe("Eliminated 091827 TA");
    expect(s.initials).toBe("TA");
    expect(s.dateCode).toBe("091827");
  });

  it("still reads a status with no signature", () => {
    const s = parseRecostStatus("eliminated");
    expect(s.kind).toBe("ELIMINATED");
    expect(s.initials).toBeNull();
    expect(s.dateCode).toBeNull();
  });

  it("does not guess at something it cannot read", () => {
    expect(parseRecostStatus("ask Craig").kind).toBe("UNRECOGNISED");
    expect(parseRecostStatus("").kind).toBe("UNRECOGNISED");
    expect(parseRecostStatus(null).kind).toBe("UNRECOGNISED");
  });

  // "No change" has to beat "change"-adjacent words, and it comes first
  // in the table for that reason.
  it("reads 'no change' as no change, not as a change", () => {
    expect(parseRecostStatus("No change").kind).toBe("NO_CHANGE");
  });
});

describe("pairSummaryRows", () => {
  // Full Swing's real summary, both versions.
  const previous: SummaryRow[] = [
    { client: "Full Swing", element: "Full Swing - Hitting Bay Wall Structure", total: 43849.05, status: null },
    { client: "Full Swing", element: "Full Swing - Diamond Sign Logo 5'4", total: 2507.54, status: null },
    { client: "Full Swing", element: "Full Swing - Reception Counter", total: 7469.02, status: null },
    { client: "Full Swing", element: "Full Swing - Lit Angled Spines (Lounge)", total: 37280.6, status: null },
    { client: "Second Swing", element: "Second Swing - Lounge Wall Structure", total: 47797.91, status: null },
  ];

  const current: SummaryRow[] = [
    {
      client: "Full Swing",
      element: "Full Swing - Hitting Bay Wall Structure",
      total: 19202.35,
      status: "Updated 091826 TA",
    },
    { client: "Full Swing", element: "Full Swing - Diamond Sign Logo 5'4", total: 0, status: "Eliminated 091827 TA" },
    { client: "Full Swing", element: "Full Swing - Reception Counter", total: 0, status: "Eliminated 091827 TA" },
    {
      client: "Full Swing",
      element: "Full Swing - Lit Angled Spines (Lounge)",
      total: 37280.6,
      status: "No  change 091827 TA",
    },
    // Client re-labelled to Full Swing while the element name keeps
    // "Second Swing" -- which is why pairing is on element, never client.
    {
      client: "Full Swing",
      element: "Second Swing - Lounge Wall Structure",
      total: 47797.91,
      status: "No  change 091827 TA",
    },
  ];

  it("turns each written status into an action", () => {
    const byElement = new Map(pairSummaryRows(previous, current).map((c) => [c.element, c]));

    expect(byElement.get("Full Swing - Reception Counter")?.action).toBe("REMOVE");
    expect(byElement.get("Full Swing - Hitting Bay Wall Structure")?.action).toBe("REPRICE");
    expect(byElement.get("Full Swing - Lit Angled Spines (Lounge)")?.action).toBe("NONE");
  });

  it("pairs on element even when the client column was re-labelled", () => {
    const row = pairSummaryRows(previous, current).find((c) => c.element.startsWith("Second Swing"));
    expect(row?.previousTotal).toBe(47797.91);
    expect(row?.action).toBe("NONE");
  });

  it("computes the real deltas", () => {
    const summary = summariseChanges(pairSummaryRows(previous, current));
    expect(summary.previousTotal).toBeCloseTo(138904.12, 2);
    expect(summary.currentTotal).toBeCloseTo(104280.86, 2);
    expect(summary.delta).toBeCloseTo(-34623.26, 2);
    expect(summary.eliminatedCount).toBe(2);
    expect(summary.repricedCount).toBe(1);
    expect(summary.unchangedCount).toBe(2);
  });

  // Biggest saving first, because that is the order the decisions get
  // made in on a job being cut to a budget.
  it("puts the largest reduction first", () => {
    const changes = pairSummaryRows(previous, current);
    expect(changes[0].element).toBe("Full Swing - Hitting Bay Wall Structure");
  });

  describe("when the note and the numbers disagree", () => {
    // Neither is silently preferred: an estimator wrote one and
    // calculated the other, and which is stale is not a guess to make.
    it("flags eliminated that still carries money", () => {
      const c = pairSummaryRows(
        [{ client: "FS", element: "Counter", total: 7469.02, status: null }],
        [{ client: "FS", element: "Counter", total: 500, status: "Eliminated 091827 TA" }],
      );
      expect(c[0].discrepancy).toMatch(/still carries 500/);
      expect(summariseChanges(c).needsReviewCount).toBe(1);
    });

    it("flags no-change that moved", () => {
      const c = pairSummaryRows(
        [{ client: "FS", element: "Spines", total: 37280.6, status: null }],
        [{ client: "FS", element: "Spines", total: 30000, status: "No change 091827 TA" }],
      );
      expect(c[0].discrepancy).toMatch(/no change but the total moved/);
    });

    it("flags updated that did not move", () => {
      const c = pairSummaryRows(
        [{ client: "FS", element: "Wall", total: 100, status: null }],
        [{ client: "FS", element: "Wall", total: 100, status: "Updated 091826 TA" }],
      );
      expect(c[0].discrepancy).toMatch(/unchanged/);
    });
  });

  // A row that simply vanished is not the same as one somebody decided
  // to eliminate, and must not be read as a saving.
  it("raises a vanished row for review rather than treating it as eliminated", () => {
    const c = pairSummaryRows(
      [{ client: "FS", element: "Gone", total: 5000, status: null }],
      [],
    );
    expect(c[0].action).toBe("REVIEW");
    expect(c[0].currentTotal).toBeNull();
    expect(c[0].discrepancy).toMatch(/missing from the revised one/);
  });

  it("treats a row only on the revised summary as an addition", () => {
    const c = pairSummaryRows([], [{ client: "FS", element: "New thing", total: 900, status: null }]);
    expect(c[0].action).toBe("ADD");
  });

  // No status written at all: the numbers are still evidence, but weaker,
  // because nobody said the change was deliberate.
  it("asks for review when a total moved with no status against it", () => {
    const c = pairSummaryRows(
      [{ client: "FS", element: "Wall", total: 1000, status: null }],
      [{ client: "FS", element: "Wall", total: 400, status: null }],
    );
    expect(c[0].action).toBe("REVIEW");
  });
});
