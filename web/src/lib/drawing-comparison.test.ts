import { describe, expect, it } from "vitest";
import { dropContradictedRemovals, readStoredComparison, type DrawingChangeFinding } from "@/lib/drawing-comparison";

function f(over: Partial<DrawingChangeFinding>): DrawingChangeFinding {
  return { kind: "REMOVED", subject: "x", detail: "", previousPage: 1, revisedPage: null, ...over };
}

describe("dropContradictedRemovals", () => {
  // Verbatim from a real run against Full Swing: the banners came back
  // as removed AND moved. Both cannot be true, and believing the removal
  // cuts cost from a job that still has the scope.
  it("drops a removal when the same subject is also reported as moved", () => {
    const out = dropContradictedRemovals([
      f({ kind: "REMOVED", subject: "hanging banners", detail: "no longer present" }),
      f({ kind: "MOVED", subject: "hanging banners", detail: "now hang from the batting cage", revisedPage: 5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("MOVED");
  });

  it("drops a removal contradicted by a CHANGED on the same subject", () => {
    const out = dropContradictedRemovals([
      f({ kind: "REMOVED", subject: "hanging sign" }),
      f({ kind: "CHANGED", subject: "Hanging Sign", detail: "now one uniform height", revisedPage: 1 }),
    ]);
    expect(out.map((x) => x.kind)).toEqual(["CHANGED"]);
  });

  // A genuine removal has nothing contradicting it and must survive --
  // this is the reception counter, the best finding the feature makes.
  it("keeps an uncontradicted removal", () => {
    const out = dropContradictedRemovals([
      f({ kind: "REMOVED", subject: "L shape reception counter" }),
      f({ kind: "ADDED", subject: "seating area", previousPage: null, revisedPage: 7 }),
    ]);
    expect(out).toHaveLength(2);
  });

  // ADDED is not a contradiction. A thing can genuinely leave one place
  // and a different thing arrive elsewhere.
  it("does not treat an ADDED of the same subject as a contradiction", () => {
    const out = dropContradictedRemovals([
      f({ kind: "REMOVED", subject: "monitor" }),
      f({ kind: "ADDED", subject: "monitor", previousPage: null, revisedPage: 3 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("leaves an empty set alone", () => {
    expect(dropContradictedRemovals([])).toEqual([]);
  });
});

describe("readStoredComparison", () => {
  // Full Swing's stored comparison was written before the contradiction
  // fix existed and still holds the hanging banners as both REMOVED and
  // MOVED. Cleaning on read is what makes the fix reach it without
  // paying for another vision run.
  it("cleans a comparison stored before the contradiction fix", () => {
    const stored = {
      revisedFilename: "REVISED.pdf",
      findings: [
        f({ kind: "REMOVED", subject: "hanging banners" }),
        f({ kind: "MOVED", subject: "hanging banners", revisedPage: 5 }),
        f({ kind: "REMOVED", subject: "front structure" }),
      ],
    };
    const out = readStoredComparison(stored);
    expect(out!.findings.map((x) => `${x.kind} ${x.subject}`)).toEqual([
      "MOVED hanging banners",
      "REMOVED front structure",
    ]);
  });

  it("leaves a clean comparison untouched", () => {
    const stored = { findings: [f({ kind: "REMOVED", subject: "front structure" })] };
    expect(readStoredComparison(stored)!.findings).toHaveLength(1);
  });

  // A document with no comparison, and a column holding something that
  // is not one, are both "nothing to show" rather than a crash.
  it("returns null for anything that is not a comparison", () => {
    expect(readStoredComparison(null)).toBeNull();
    expect(readStoredComparison("{}")).toBeNull();
    expect(readStoredComparison({})).toBeNull();
    expect(readStoredComparison({ findings: "lots" })).toBeNull();
  });
});
