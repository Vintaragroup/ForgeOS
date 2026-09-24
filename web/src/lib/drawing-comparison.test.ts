import { describe, expect, it } from "vitest";
import { dropContradictedRemovals, type DrawingChangeFinding } from "@/lib/drawing-comparison";

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
