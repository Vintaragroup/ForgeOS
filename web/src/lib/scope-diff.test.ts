import { describe, expect, it } from "vitest";
import { computeScopeDiff } from "@/lib/scope-diff";

describe("computeScopeDiff", () => {
  it("reports nothing when the schedule is unchanged", () => {
    const rows = [
      { description: "Hitting bay wall", qty: 4 },
      { description: "Lounge structure", qty: 1 },
    ];
    const diff = computeScopeDiff(rows, rows);
    expect(diff.rows).toEqual([]);
    expect(diff.unchangedCount).toBe(2);
  });

  // The half nothing could see before: a line the client cut was simply
  // never re-proposed, so nothing noticed it was gone.
  it("catches a line the client dropped", () => {
    const diff = computeScopeDiff(
      [
        { description: "LED wall, 20ft", qty: 1 },
        { description: "Hitting bay wall", qty: 4 },
      ],
      [{ description: "Hitting bay wall", qty: 4 }],
    );
    expect(diff.removedCount).toBe(1);
    expect(diff.rows[0]).toMatchObject({ description: "LED wall, 20ft", kind: "REMOVED", previousQty: 1, currentQty: null });
  });

  it("catches a count moving", () => {
    const diff = computeScopeDiff(
      [{ description: "Hitting bay wall", qty: 4 }],
      [{ description: "Hitting bay wall", qty: 2 }],
    );
    expect(diff.qtyChangedCount).toBe(1);
    expect(diff.rows[0]).toMatchObject({ kind: "QTY_CHANGED", previousQty: 4, currentQty: 2 });
  });

  it("catches something new", () => {
    const diff = computeScopeDiff([], [{ description: "Reception counter", qty: 1, unit: "EA" }]);
    expect(diff.addedCount).toBe(1);
    expect(diff.rows[0]).toMatchObject({ kind: "ADDED", previousQty: null, currentQty: 1, unit: "EA" });
  });

  // Vendors and clients retype descriptions between revisions. Matching
  // on the raw string would report a whole schedule as cut-and-re-added.
  it("matches across retyped spacing, case and trailing punctuation", () => {
    const diff = computeScopeDiff(
      [{ description: "Hitting  Bay Wall.", qty: 4 }],
      [{ description: "hitting bay wall", qty: 4 }],
    );
    expect(diff.rows).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  // Two "Shop Supplies" rows are a real thing on a schedule.
  it("pairs duplicate descriptions in order rather than collapsing them", () => {
    const diff = computeScopeDiff(
      [
        { description: "Shop supplies", qty: 1 },
        { description: "Shop supplies", qty: 5 },
      ],
      [
        { description: "Shop supplies", qty: 1 },
        { description: "Shop supplies", qty: 9 },
      ],
    );
    expect(diff.qtyChangedCount).toBe(1);
    expect(diff.rows[0]).toMatchObject({ previousQty: 5, currentQty: 9 });
    expect(diff.unchangedCount).toBe(1);
  });

  // On a job being cut to a budget, what came OUT is what is being
  // looked for.
  it("puts removals first", () => {
    const diff = computeScopeDiff(
      [
        { description: "Kept", qty: 1 },
        { description: "Cut", qty: 1 },
        { description: "Halved", qty: 4 },
      ],
      [
        { description: "Kept", qty: 1 },
        { description: "Halved", qty: 2 },
        { description: "New", qty: 1 },
      ],
    );
    expect(diff.rows.map((r) => r.kind)).toEqual(["REMOVED", "QTY_CHANGED", "ADDED"]);
  });
});
