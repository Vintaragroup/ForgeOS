import { describe, expect, it } from "vitest";
import {
  corroborateDrawingAgainstSchedule,
  corroborationHeadline,
  subjectMatchesElement,
} from "@/lib/recost-corroboration";
import type { DrawingChangeFinding } from "@/lib/drawing-comparison";
import { parseRecostStatus } from "@/lib/recost-status";
import type { ElementChange } from "@/lib/recost-status";

function finding(over: Partial<DrawingChangeFinding>): DrawingChangeFinding {
  return { kind: "REMOVED", subject: "x", detail: "", previousPage: null, revisedPage: null, ...over };
}

function element(over: Partial<ElementChange>): ElementChange {
  return {
    element: "x",
    previousTotal: null,
    currentTotal: null,
    delta: null,
    status: parseRecostStatus(null),
    action: "NONE",
    discrepancy: null,
    ...over,
  };
}

describe("subjectMatchesElement", () => {
  // Full Swing's real pairs, both directions of containment.
  it("matches a drawing's words inside a schedule row", () => {
    expect(subjectMatchesElement("hanging sign", 'Full Swing - Diamond Sign Logo 5\'4" (Qty 1, Hanging Sign)')).toBe(
      true,
    );
    expect(subjectMatchesElement("L shape reception counter", "Full Swing - Reception Counter")).toBe(true);
  });

  // The failure that would cost the most: two different structures
  // sharing one generic noun.
  it("does not pair things that share only a generic word", () => {
    expect(subjectMatchesElement("front structure", "Full Swing - Hitting Bay Wall Structure")).toBe(false);
    expect(subjectMatchesElement("rear structure with closet", "Second Swing - Lounge Wall Structure")).toBe(false);
    expect(subjectMatchesElement("hanging banners", "Full Swing - Reception Counter")).toBe(false);
  });

  // "FS -" and "SS -" are client names -- Full Swing and Second Swing
  // share the stand. Dropped for matching, because no drawing says them.
  it("ignores the client prefix on a schedule row", () => {
    expect(subjectMatchesElement("lounge wall structure", "Second Swing - Lounge Wall Structure")).toBe(true);
  });

  it("refuses to pair on a single word", () => {
    expect(subjectMatchesElement("counter", "Full Swing - Reception Counter")).toBe(false);
  });

  it("survives plurals and punctuation", () => {
    expect(subjectMatchesElement("angled spines", "Full Swing - Lit Angled Spines (Lounge)")).toBe(true);
  });
});

describe("corroborateDrawingAgainstSchedule", () => {
  // Verbatim from the production comparison run on 2026-09-24.
  const findings: DrawingChangeFinding[] = [
    finding({
      kind: "CHANGED",
      subject: "hanging sign",
      detail: "The hanging sign now displays additional text reading 'FEEDBACK PERFORMANCE'",
      previousPage: 2,
      revisedPage: 1,
    }),
    finding({
      kind: "REMOVED",
      subject: "L shape reception counter",
      detail: "The L-shaped reception counter ... is no longer present.",
      previousPage: 7,
    }),
    finding({ kind: "REMOVED", subject: "front structure", detail: "no longer present", previousPage: 5 }),
    finding({
      kind: "ADDED",
      subject: "seating area with tables and chairs",
      detail: "A seating area with multiple small round tables and chairs",
      revisedPage: 7,
    }),
  ];

  const elements: ElementChange[] = [
    element({
      element: "Full Swing - Reception Counter",
      previousTotal: 7469.02,
      currentTotal: 0,
      action: "REMOVE",
      status: parseRecostStatus("Eliminated 091827 TA"),
    }),
    element({
      element: 'Full Swing - Diamond Sign Logo 5\'4" (Qty 1, Hanging Sign)',
      previousTotal: 2507.54,
      currentTotal: 0,
      action: "REMOVE",
    }),
    element({
      element: "Full Swing - Lit Angled Spines (Lounge)",
      previousTotal: 37280.6,
      currentTotal: 37280.6,
      action: "NONE",
    }),
  ];

  it("reports two independent sources agreeing that scope is gone", () => {
    const out = corroborateDrawingAgainstSchedule({ findings, elements, charactersMismatched: false });
    const counter = out.find((f) => f.subject === "L shape reception counter");
    expect(counter?.kind).toBe("CORROBORATED");
    expect(counter?.element).toBe("Full Swing - Reception Counter");
    expect(counter?.amount).toBe(7469.02);
    // Checkable rather than believable.
    expect(counter?.pages).toBe("was p7");
  });

  it("flags new scope nobody has priced", () => {
    const out = corroborateDrawingAgainstSchedule({ findings, elements, charactersMismatched: false });
    const seating = out.find((f) => f.subject.startsWith("seating area"));
    expect(seating?.kind).toBe("ADDED_NOT_PRICED");
    expect(seating?.amount).toBeNull();
  });

  it("does not claim money about a change or a move", () => {
    const out = corroborateDrawingAgainstSchedule({ findings, elements, charactersMismatched: false });
    const sign = out.find((f) => f.subject === "hanging sign");
    // Paired with the sign row, but a sign that gained lettering is a
    // question, never a removal.
    expect(sign?.kind).toBe("DRAWN_NOT_PRICED");
  });

  it("keeps a removal the schedule has nothing for as an open question", () => {
    const out = corroborateDrawingAgainstSchedule({ findings, elements, charactersMismatched: false });
    const front = out.find((f) => f.subject === "front structure");
    expect(front?.kind).toBe("DRAWN_NOT_PRICED");
    expect(front?.element).toBeNull();
  });

  // The one worth waking someone for: the drawing says it is gone, the
  // estimator marked it no change, and $37,281 is sitting in the
  // estimate either way.
  it("flags money the schedule still carries for scope the drawing dropped", () => {
    const out = corroborateDrawingAgainstSchedule({
      findings: [finding({ kind: "REMOVED", subject: "lit angled spines", previousPage: 4 })],
      elements,
      charactersMismatched: false,
    });
    expect(out[0].kind).toBe("STILL_PRICED");
    expect(out[0].amount).toBe(37280.6);
  });

  it("puts unresolved money ahead of agreement", () => {
    const out = corroborateDrawingAgainstSchedule({
      findings: [...findings, finding({ kind: "REMOVED", subject: "lit angled spines" })],
      elements,
      charactersMismatched: false,
    });
    expect(out[0].kind).toBe("STILL_PRICED");
    expect(out[out.length - 1].kind).toBe("CORROBORATED");
  });

  // A dimensioned component set against a rendering: the same object
  // drawn two ways can read as removed and added, so every finding
  // carries the warning rather than the card remembering to add it.
  it("marks every finding softened when the drawings are different kinds", () => {
    const out = corroborateDrawingAgainstSchedule({ findings, elements, charactersMismatched: true });
    expect(out.every((f) => f.softened)).toBe(true);
  });

  it("says nothing when there is nothing to say", () => {
    expect(corroborateDrawingAgainstSchedule({ findings: [], elements, charactersMismatched: false })).toEqual([]);
  });
});

describe("corroborationHeadline", () => {
  it("leads with what is unpriced, not with what agrees", () => {
    const out = corroborateDrawingAgainstSchedule({
      findings: [
        finding({ kind: "ADDED", subject: "seating area with tables" }),
        finding({ kind: "REMOVED", subject: "L shape reception counter" }),
      ],
      elements: [element({ element: "Full Swing - Reception Counter", action: "REMOVE", previousTotal: 7469.02 })],
      charactersMismatched: false,
    });
    const headline = corroborationHeadline(out, "REVISED.pdf");
    expect(headline).toMatch(/^1 change in REVISED\.pdf that nothing has priced/);
    expect(headline).toMatch(/1 the re-cost already accounts for/);
  });

  it("does not invent findings for a drawing that changed nothing", () => {
    expect(corroborationHeadline([], "REVISED.pdf")).toMatch(/no change anyone has to price/);
  });
});
