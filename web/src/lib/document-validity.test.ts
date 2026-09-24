import { describe, expect, it } from "vitest";
import {
  effectiveValidity,
  groupStaleLineItems,
  isStaleSource,
  staleSourceExplanation,
  type ValiditySource,
} from "@/lib/document-validity";

function doc(over: Partial<ValiditySource> = {}): ValiditySource {
  return {
    id: "d1",
    filename: "quote-369711-V2.pdf",
    validity: "CURRENT",
    validityNote: null,
    supersededByFilename: null,
    ...over,
  };
}

describe("effectiveValidity", () => {
  it("is CURRENT for a document nothing has replaced", () => {
    expect(effectiveValidity(doc())).toBe("CURRENT");
  });

  // The chain is the truth. A stored CURRENT on a document that has been
  // superseded would drift the moment a link changed.
  it("derives SUPERSEDED from the chain, whatever the column says", () => {
    expect(effectiveValidity(doc({ supersededByFilename: "updated 091826.xlsx" }))).toBe("SUPERSEDED");
  });

  // Only a person knows a vendor is off the job, so a declared
  // withdrawal always wins -- including over a chain that would
  // otherwise say SUPERSEDED.
  it("lets a declared WITHDRAWN win over the chain", () => {
    expect(
      effectiveValidity({ validity: "WITHDRAWN", supersededByFilename: "something-newer.pdf" }),
    ).toBe("WITHDRAWN");
  });
});

describe("isStaleSource", () => {
  it("is false only for a current source", () => {
    expect(isStaleSource(doc())).toBe(false);
    expect(isStaleSource(doc({ validity: "WITHDRAWN" }))).toBe(true);
    expect(isStaleSource(doc({ supersededByFilename: "newer.xlsx" }))).toBe(true);
  });
});

describe("staleSourceExplanation", () => {
  it("says nothing about a current source", () => {
    expect(staleSourceExplanation(doc())).toBeNull();
  });

  it("carries the estimator's own reason for a withdrawal", () => {
    const e = staleSourceExplanation(
      doc({ validity: "WITHDRAWN", validityNote: "Fuse is no longer supplying AV on this job" }),
    );
    expect(e).toMatch(/no longer a valid source/);
    expect(e).toMatch(/Fuse is no longer supplying AV/);
  });

  it("names the replacement for a superseded source", () => {
    expect(staleSourceExplanation(doc({ supersededByFilename: "estimates updated 091826.xlsx" }))).toMatch(
      /replaced by estimates updated 091826\.xlsx/,
    );
  });

  // The wording must never imply the line items are going away. On a
  // value-engineering job they almost certainly are not.
  it("never says anything is being removed", () => {
    for (const d of [
      doc({ validity: "WITHDRAWN", validityNote: "Fuse is off the job" }),
      doc({ supersededByFilename: "newer.xlsx" }),
    ]) {
      expect(staleSourceExplanation(d)).not.toMatch(/remov|delet|drop/i);
    }
  });
});

describe("groupStaleLineItems", () => {
  // ABC Chicago's real shape: a withdrawn AV quote carrying 16 line
  // items, and a superseded schedule carrying far more.
  const documents = [
    doc({ id: "fuse", filename: "369711-V2.pdf", validity: "WITHDRAWN", validityNote: "Fuse is off the job" }),
    doc({ id: "sched", filename: "ABCA_2027_Exhibit_Cost_Breakout.xlsx", supersededByFilename: "updated 091826.xlsx" }),
    doc({ id: "iac", filename: "quote-55672.pdf" }),
  ];

  it("groups line items under the stale source that produced them", () => {
    const groups = groupStaleLineItems(
      [
        { documentId: "fuse", totalCost: 16460 },
        { documentId: "fuse", totalCost: 18700 },
        { documentId: "sched", totalCost: 400 },
        { documentId: "iac", totalCost: 55943 },
        { documentId: null, totalCost: 900 },
      ],
      documents,
    );

    expect(groups.map((g) => g.documentId)).toEqual(["fuse", "sched"]);
    expect(groups[0].lineItemCount).toBe(2);
    expect(groups[0].totalCost).toBe(35160);
    // A current source produces no group at all, and neither does a line
    // item with no provenance.
    expect(groups.find((g) => g.documentId === "iac")).toBeUndefined();
  });

  // A withdrawn source leaves a hole; a superseded one at least has a
  // replacement to compare against.
  it("puts a withdrawal ahead of a supersession at lower money", () => {
    const groups = groupStaleLineItems(
      [
        { documentId: "fuse", totalCost: 100 },
        { documentId: "sched", totalCost: 99999 },
      ],
      documents,
    );
    expect(groups[0].documentId).toBe("fuse");
  });

  it("orders by money within the same validity", () => {
    const groups = groupStaleLineItems(
      [
        { documentId: "sched", totalCost: 500 },
        { documentId: "other", totalCost: 9000 },
      ],
      [...documents, doc({ id: "other", filename: "other.xlsx", supersededByFilename: "newer.xlsx" })],
    );
    expect(groups.map((g) => g.documentId)).toEqual(["other", "sched"]);
  });

  it("returns nothing when every source is current", () => {
    expect(groupStaleLineItems([{ documentId: "iac", totalCost: 1 }], documents)).toEqual([]);
  });
});
