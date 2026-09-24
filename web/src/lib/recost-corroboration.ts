// What the revised drawing shows against what the estimator re-costed.
//
// Two independent witnesses to the same redesign. On Full Swing they
// agree about the reception counter -- the drawing says the L-shaped
// counter is gone from sheet 7, and the schedule says "Eliminated 091827
// TA" against $7,469.02 -- and neither of them knew about the other.
// That agreement is worth saying out loud, because it is the difference
// between a model's claim and a fact.
//
// The disagreements are worth more. A drawing showing scope gone while
// the schedule still carries its full price is money in an estimate that
// may not belong there; new scope in a drawing that nothing has priced
// is money missing from one. Both are invisible to either source alone.
//
// What this never does is decide. It pairs an observation with a row and
// says they disagree. Which one is stale is not something a token
// overlap can know.
//
// A leaf module: pure functions over plain rows, no db import.

import type { DrawingChangeFinding } from "@/lib/drawing-comparison";
import type { ElementChange } from "@/lib/recost-status";

export type CorroborationKind =
  // The drawing and the schedule agree the scope is gone.
  | "CORROBORATED"
  // The drawing shows it gone; the estimator marked it no change. The
  // money is still in the estimate.
  | "STILL_PRICED"
  // New scope in the revised drawing that nothing has priced.
  | "ADDED_NOT_PRICED"
  // A change the drawing shows and the schedule is silent about.
  | "DRAWN_NOT_PRICED";

export interface CorroborationFinding {
  kind: CorroborationKind;
  // As the drawing named it, and in the drawing's own words. Quoted
  // rather than paraphrased so a person can check it against the sheet.
  subject: string;
  detail: string;
  // The schedule row it was paired with, when there was one.
  element: string | null;
  amount: number | null;
  // Where to look. A finding nobody can check is a finding nobody should
  // act on.
  pages: string;
  // The two drawings are different kinds -- a dimensioned component set
  // against a rendering. Their findings are softer than they look,
  // because the same object drawn two ways can read as removed and
  // added. See drawing-character.ts.
  softened: boolean;
}

// Words that carry no identity. "The rear structure with closet" and
// "the front structure" share only `structure`, and that is not a match.
const STOPWORDS = new Set([
  "a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with", "qty", "s",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
      .filter((w) => w && !STOPWORDS.has(w)),
  );
}

// Drops the client prefix from an element name for MATCHING only.
//
// "FS -" and "SS -" are client names, not booth positions: Full Swing
// and Second Swing are two companies sharing a stand, and the workbook
// subtotals them separately. A drawing never says them, so they would
// only ever weaken a match -- but they are never dropped from anything
// displayed, because "Lounge Wall Structure" alone does not say whose.
function matchableElementName(element: string): string {
  const separator = element.indexOf(" - ");
  return separator === -1 ? element : element.slice(separator + 3);
}

// Whether a drawing's subject and a schedule row name the same thing.
//
// Containment rather than overlap: every significant word of one side
// has to appear in the other. "hanging sign" sits inside "Diamond Sign
// Logo 5'4\" (Qty 1, Hanging Sign)" and matches; "front structure"
// against "Hitting Bay Wall Structure" shares only `structure` and does
// not. Two words minimum, so a lone generic noun never pairs anything.
export function subjectMatchesElement(subject: string, element: string): boolean {
  const a = tokens(subject);
  const b = tokens(matchableElementName(element));
  if (a.size < 2 || b.size < 2) return false;

  const contains = (small: Set<string>, large: Set<string>) => [...small].every((w) => large.has(w));
  return contains(a, b) || contains(b, a);
}

function pagesOf(finding: DrawingChangeFinding): string {
  const parts: string[] = [];
  if (finding.previousPage !== null) parts.push(`was p${finding.previousPage}`);
  if (finding.revisedPage !== null) parts.push(`now p${finding.revisedPage}`);
  return parts.join(", ");
}

// Ordered by what it costs to be wrong about, not by confidence.
//
// Money still in the estimate that the drawing says is gone comes first,
// then scope in the drawing that nothing has priced. Agreement comes
// last: it is the most trustworthy thing here and the least urgent,
// because nothing needs doing about it.
const ORDER: Record<CorroborationKind, number> = {
  STILL_PRICED: 0,
  ADDED_NOT_PRICED: 1,
  DRAWN_NOT_PRICED: 2,
  CORROBORATED: 3,
};

export function corroborateDrawingAgainstSchedule(input: {
  findings: DrawingChangeFinding[];
  elements: ElementChange[];
  charactersMismatched: boolean;
}): CorroborationFinding[] {
  const { findings, elements, charactersMismatched } = input;

  const out: CorroborationFinding[] = findings.map((finding) => {
    const element = elements.find((e) => subjectMatchesElement(finding.subject, e.element)) ?? null;
    const base = {
      subject: finding.subject,
      detail: finding.detail,
      element: element?.element ?? null,
      pages: pagesOf(finding),
      softened: charactersMismatched,
    };

    if (finding.kind === "ADDED") {
      // A match here would mean the schedule already carries it, which
      // is the one case where added scope is not a hole.
      return element
        ? { ...base, kind: "DRAWN_NOT_PRICED" as const, amount: element.currentTotal }
        : { ...base, kind: "ADDED_NOT_PRICED" as const, amount: null };
    }

    if (finding.kind === "REMOVED" && element) {
      if (element.action === "REMOVE") {
        return { ...base, kind: "CORROBORATED" as const, amount: element.previousTotal };
      }
      if (element.action === "NONE") {
        // The loud one: two sources, one says gone, one says unchanged,
        // and the money is sitting in the estimate either way.
        return { ...base, kind: "STILL_PRICED" as const, amount: element.currentTotal };
      }
    }

    // MOVED and CHANGED never claim anything about money. Relocated
    // scope still costs something, possibly something different, and a
    // sign that gained lettering is a question for whoever prices signs.
    return { ...base, kind: "DRAWN_NOT_PRICED" as const, amount: element?.currentTotal ?? null };
  });

  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (b.amount ?? 0) - (a.amount ?? 0));
}

// One line for the top of the card.
//
// Leads with what is unresolved. Agreement is mentioned second and only
// when there is some, because "2 findings confirmed" at the front of a
// sentence reads as a clean bill of health on a drawing carrying four
// open questions.
export function corroborationHeadline(findings: CorroborationFinding[], revisedFilename: string): string {
  if (findings.length === 0) return `${revisedFilename} shows no change anyone has to price.`;

  const open = findings.filter((f) => f.kind !== "CORROBORATED").length;
  const agreed = findings.length - open;

  const parts: string[] = [];
  if (open > 0) {
    parts.push(`${open} change${open === 1 ? "" : "s"} in ${revisedFilename} that nothing has priced`);
  }
  if (agreed > 0) {
    parts.push(`${agreed} the re-cost already accounts for`);
  }
  return `${parts.join(", and ")}.`;
}
