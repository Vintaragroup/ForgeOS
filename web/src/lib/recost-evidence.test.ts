import { describe, expect, it } from "vitest";
import {
  collectEvidence,
  evidenceFromDrawingComparison,
  evidenceFromScopeDiff,
  isMaterial,
  resolveBoothLabel,
  resolveLineItemMatch,
  MATERIAL_AMOUNT,
  type RecostEvidence,
} from "@/lib/recost-evidence";
import { computeScopeDiff } from "@/lib/scope-diff";
import type { DrawingComparison } from "@/lib/drawing-comparison";

// ABC Chicago's real booth labels.
const BOOTHS = [
  "FS - Reception Counter",
  "FS - Hitting Bay Wall",
  "SS - Lit Spines Hit Bay",
  "FS - Lit Spines Lounge",
  "SS - Lounge Structure",
  "RENTAL",
];

describe("resolveBoothLabel", () => {
  // The finding that made the whole feature worth building.
  it("matches a drawing's words to a booth label", () => {
    expect(resolveBoothLabel("reception counter", BOOTHS)).toBe("FS - Reception Counter");
  });

  it("ignores the FS/SS prefix and punctuation", () => {
    expect(resolveBoothLabel("Hitting Bay Wall", BOOTHS)).toBe("FS - Hitting Bay Wall");
  });

  // A wrong booth points a removal at the wrong 25 line items, which is
  // worse than admitting it does not know.
  it("refuses an ambiguous match rather than picking one", () => {
    // "lounge" is inside both "Lit Spines Lounge" and "Lounge Structure".
    expect(resolveBoothLabel("lounge", BOOTHS)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveBoothLabel("video wall", BOOTHS)).toBeNull();
    expect(resolveBoothLabel("", BOOTHS)).toBeNull();
  });
});

describe("isMaterial", () => {
  it("raises anything at or above the threshold", () => {
    expect(isMaterial(MATERIAL_AMOUNT, false)).toBe(true);
    expect(isMaterial(-MATERIAL_AMOUNT, false)).toBe(true);
  });

  it("drops small movements", () => {
    expect(isMaterial(50, false)).toBe(false);
  });

  // A whole booth leaving is a scope decision, not a rounding one.
  it("always raises a whole section, whatever it costs", () => {
    expect(isMaterial(10, true)).toBe(true);
  });

  // A schedule carries no prices at all, so "no amount" must not mean
  // "not worth raising".
  it("raises a finding with no money attached", () => {
    expect(isMaterial(null, false)).toBe(true);
  });
});

describe("evidenceFromScopeDiff", () => {
  it("scopes every row to the document that produced the line items", () => {
    const diff = computeScopeDiff(
      [{ description: "Reception counter carcass", qty: 1 }],
      [{ description: "Hitting bay panel", qty: 2 }],
    );
    const ev = evidenceFromScopeDiff(diff, { id: "new-doc", filename: "revised.xlsx" }, "old-doc");

    expect(ev.every((e) => e.scopedToDocumentId === "old-doc")).toBe(true);
    expect(ev.every((e) => e.scopedToBooth === null)).toBe(true);
    // A schedule has no price column, so it must never claim an amount.
    expect(ev.every((e) => e.amount === null)).toBe(true);
    expect(ev.find((e) => e.kind === "DROPPED")?.subject).toBe("Reception counter carcass");
  });
});

describe("evidenceFromDrawingComparison", () => {
  function comparison(over: Partial<DrawingComparison> = {}): DrawingComparison {
    return {
      previousDocumentId: "old",
      previousFilename: "COMPONENTS.pdf",
      revisedDocumentId: "new",
      revisedFilename: "90X20.pdf",
      findings: [
        {
          kind: "REMOVED",
          subject: "reception counter",
          detail: "The L-shaped reception counter is no longer present.",
          previousPage: 7,
          revisedPage: null,
        },
      ],
      previousPagesCompared: 7,
      revisedPagesCompared: 14,
      charactersMismatched: false,
      previousCharacter: "DIMENSIONED",
      revisedCharacter: "DIMENSIONED",
      comparedAt: "2026-09-24T12:00:00.000Z",
      ...over,
    };
  }

  it("scopes a finding to a booth, never to a document", () => {
    const ev = evidenceFromDrawingComparison(comparison(), (s) => resolveBoothLabel(s, BOOTHS));
    expect(ev[0].scopedToBooth).toBe("FS - Reception Counter");
    expect(ev[0].scopedToDocumentId).toBeNull();
    expect(ev[0].sourceLocation).toBe("p7 of COMPONENTS.pdf");
  });

  // Reported rather than dropped: "something changed and I could not
  // tell you where" is worth an estimator's attention.
  // Booth is the coarser, safer scope: a finding naming a whole booth
  // acts on the booth, not on one line inside it.
  it("prefers a booth over a line item when both would match", () => {
    const ev = evidenceFromDrawingComparison(
      comparison(),
      (s) => resolveBoothLabel(s, BOOTHS),
      () => "li-should-not-win",
    );
    expect(ev[0].scopedToBooth).toBe("FS - Reception Counter");
    expect(ev[0].scopedToLineItemId).toBeNull();
  });

  it("falls back to a line item when no booth matches", () => {
    const ev = evidenceFromDrawingComparison(
      comparison({ findings: [{ kind: "CHANGED", subject: "hanging sign", detail: "simpler now", previousPage: 2, revisedPage: 1 }] }),
      (s) => resolveBoothLabel(s, BOOTHS),
      () => "li-sign",
    );
    expect(ev[0].scopedToBooth).toBeNull();
    expect(ev[0].scopedToLineItemId).toBe("li-sign");
  });

  it("keeps a finding that resolves to no booth", () => {
    const ev = evidenceFromDrawingComparison(
      comparison({ findings: [{ kind: "REMOVED", subject: "video wall", detail: "gone", previousPage: 5, revisedPage: null }] }),
      (s) => resolveBoothLabel(s, BOOTHS),
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].scopedToBooth).toBeNull();
  });

  // The batting cage lesson: a component sheet against a rendering
  // reports drawing style as design change.
  it("carries the mismatched-kinds caveat into the evidence itself", () => {
    const ev = evidenceFromDrawingComparison(
      comparison({ charactersMismatched: true, revisedCharacter: "RENDERING" }),
      (s) => resolveBoothLabel(s, BOOTHS),
    );
    expect(ev[0].detail).toMatch(/different kinds/);
  });
});

describe("resolveLineItemMatch", () => {
  const ITEMS = [
    { id: "li-sign", description: "Hanging Sign" },
    { id: "li-screen", description: "LED Screen 8'h x 11.39'w (BeMatrix Compatible) - and monitor" },
    { id: "li-a", description: "SEG BACKLIT — ceiling" },
    { id: "li-b", description: "SEG — side wall" },
  ];

  // The finding this widening exists for: the hanging sign is not a
  // booth, it is the single biggest line the client asked to change.
  it("matches a drawing's word to the line item it names", () => {
    expect(resolveLineItemMatch("hanging sign", ITEMS)).toBe("li-sign");
  });

  // "sign" alone would hit every signage line there is.
  it("refuses a phrase too short to be specific", () => {
    expect(resolveLineItemMatch("sign", ITEMS)).toBeNull();
  });

  it("refuses when several lines match, since each is a different amount", () => {
    expect(resolveLineItemMatch("seg", ITEMS)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveLineItemMatch("reception counter", ITEMS)).toBeNull();
  });
});

describe("collectEvidence", () => {
  function ev(over: Partial<RecostEvidence>): RecostEvidence {
    return {
      kind: "DROPPED",
      subject: "x",
      detail: "",
      sourceQuote: "x",
      sourceDocumentId: "d",
      sourceFilename: "f",
      sourceLocation: null,
      scopedToDocumentId: null,
      scopedToBooth: null,
      scopedToLineItemId: null,
      amount: null,
      ...over,
    };
  }

  // On a job being cut to a budget, what left is what is being looked
  // for -- and it was the half nothing could see before.
  it("puts what left first and the biggest movements before the rest", () => {
    const out = collectEvidence([
      ev({ kind: "ADDED", subject: "new thing", amount: 900 }),
      ev({ kind: "REPRICED", subject: "repriced", amount: 5000 }),
      ev({ kind: "DROPPED", subject: "small drop", amount: 600 }),
      ev({ kind: "DROPPED", subject: "big drop", amount: 16460 }),
      ev({ kind: "DESIGN_CHANGED", subject: "design" }),
    ]);
    expect(out.map((e) => e.subject)).toEqual(["big drop", "small drop", "design", "repriced", "new thing"]);
  });

  it("drops immaterial movements", () => {
    const out = collectEvidence([ev({ subject: "noise", amount: 25 }), ev({ subject: "real", amount: 5000 })]);
    expect(out.map((e) => e.subject)).toEqual(["real"]);
  });
});
