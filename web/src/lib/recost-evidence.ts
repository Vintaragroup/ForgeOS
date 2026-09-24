// What the revised documents actually say, before anything interprets
// them.
//
// Stage 1 of the re-cost review (docs/recost-review.md). Deterministic
// and AI-free on purpose: the AI stage's job is to map "the reception
// counter is absent" onto the 25 line items that ARE the reception
// counter, and it should be handed facts rather than asked to find them.
//
// The two scoping rules live here, and they are the whole safety story:
//
//   Absence is not evidence of removal. A line missing from the revised
//   fabrication sheet may have been cut, or may simply never have been
//   that sheet's business -- the video wall was never on it either way.
//
//   So a priced or scheduled document may only speak about line items
//   its own predecessor produced (LineItem.documentId), and a drawing --
//   which produces no line items at all -- may only speak about booths.
//
// A leaf module: pure functions over plain rows, no db import.

import type { ScopeDiff } from "@/lib/scope-diff";
import type { DocumentDiff } from "@/lib/document-diff";
import type { DrawingComparison } from "@/lib/drawing-comparison";

export type EvidenceKind = "DROPPED" | "ADDED" | "QTY_CHANGED" | "REPRICED" | "DESIGN_CHANGED";

export interface RecostEvidence {
  kind: EvidenceKind;
  // What the source says, in the source's own terms.
  subject: string;
  detail: string;
  // Verbatim, for the citation every proposal must carry.
  sourceQuote: string;
  sourceDocumentId: string;
  sourceFilename: string;
  sourceLocation: string | null;
  // Exactly one of these constrains what may be proposed from it.
  scopedToDocumentId: string | null;
  scopedToBooth: string | null;
  // A specific line item the finding names, when it names one
  // unambiguously. A drawing finding may carry this OR a booth.
  scopedToLineItemId: string | null;
  // Money, when the source carries any. A schedule never does.
  amount: number | null;
}

// Below this, a finding is noise. The estimating rules gate every
// question on "materially affects" and never define it (Estimate-
// Guidelines s1), so this is a starting threshold rather than a derived
// one -- low enough to catch anything worth an estimator's attention on
// a $650k job, high enough not to list every bracket. Expected to move
// once a real review has been run.
export const MATERIAL_AMOUNT = 500;

// A whole section or booth leaving is always worth raising, whatever it
// costs: it is a scope decision, not a rounding one.
export function isMaterial(amount: number | null, wholeSection: boolean): boolean {
  if (wholeSection) return true;
  if (amount === null) return true; // no money attached -- let a human judge
  return Math.abs(amount) >= MATERIAL_AMOUNT;
}

// A revised priced document (a vendor quote) against the line items its
// predecessor produced. This is the only source that carries amounts.
export function evidenceFromDocumentDiff(
  diff: DocumentDiff,
  source: { id: string; filename: string },
  predecessorId: string,
): RecostEvidence[] {
  return diff.rows.map((row) => ({
    kind: row.kind === "REMOVED" ? ("DROPPED" as const) : row.kind === "ADDED" ? ("ADDED" as const) : ("REPRICED" as const),
    subject: row.description,
    detail:
      row.kind === "REMOVED"
        ? `No longer on ${source.filename}.`
        : row.kind === "ADDED"
          ? `New on ${source.filename}.`
          : `Repriced on ${source.filename}.`,
    sourceQuote: row.description,
    sourceDocumentId: source.id,
    sourceFilename: source.filename,
    sourceLocation: null,
    scopedToDocumentId: predecessorId,
    scopedToBooth: null,
    scopedToLineItemId: null,
    amount: row.delta,
  }));
}

// A revised schedule against the line items its predecessor produced.
// Carries no money at all -- a pricing schedule has no price column, the
// cost comes from the catalog at import -- so every amount here is null
// and materiality falls to the human.
export function evidenceFromScopeDiff(
  diff: ScopeDiff,
  source: { id: string; filename: string },
  predecessorId: string,
): RecostEvidence[] {
  return diff.rows.map((row) => ({
    kind:
      row.kind === "REMOVED" ? ("DROPPED" as const) : row.kind === "ADDED" ? ("ADDED" as const) : ("QTY_CHANGED" as const),
    subject: row.description,
    detail:
      row.kind === "REMOVED"
        ? `No longer on ${source.filename}.`
        : row.kind === "ADDED"
          ? `New on ${source.filename}.`
          : `Quantity ${row.previousQty} → ${row.currentQty}${row.unit ? ` ${row.unit}` : ""}.`,
    sourceQuote: row.description,
    sourceDocumentId: source.id,
    sourceFilename: source.filename,
    sourceLocation: null,
    scopedToDocumentId: predecessorId,
    scopedToBooth: null,
    scopedToLineItemId: null,
    amount: null,
  }));
}

// A revised drawing against the drawing it replaces. Scoped to booths,
// because a drawing produces no line items -- see the module header.
//
// Findings from a pair of DIFFERENT KINDS of drawing (a component sheet
// against a rendering) are softer evidence than they look: the same
// object drawn two ways can read as removed and added. The comparison
// records that, and it is carried through here so the AI stage and the
// reviewer both see it.
export function evidenceFromDrawingComparison(
  comparison: DrawingComparison,
  resolveBooth: (subject: string) => string | null,
  resolveLineItem: (subject: string) => string | null = () => null,
): RecostEvidence[] {
  const caveat = comparison.charactersMismatched
    ? " These two drawings are different kinds, so this may be a change of drawing style rather than of design."
    : "";

  return comparison.findings.map((f) => ({
    kind:
      f.kind === "REMOVED" ? ("DROPPED" as const) : f.kind === "ADDED" ? ("ADDED" as const) : ("DESIGN_CHANGED" as const),
    subject: f.subject,
    detail: `${f.detail}${caveat}`,
    sourceQuote: f.detail,
    sourceDocumentId: comparison.revisedDocumentId,
    sourceFilename: comparison.revisedFilename,
    sourceLocation:
      f.previousPage !== null && f.revisedPage !== null
        ? `was p${f.previousPage}, now p${f.revisedPage}`
        : f.previousPage !== null
          ? `p${f.previousPage} of ${comparison.previousFilename}`
          : f.revisedPage !== null
            ? `p${f.revisedPage}`
            : null,
    scopedToDocumentId: null,
    // Booth first: it is the coarser, safer scope, and a finding that
    // names a whole booth should act on the booth rather than on one
    // line inside it.
    scopedToBooth: resolveBooth(f.subject),
    scopedToLineItemId: resolveBooth(f.subject) ? null : resolveLineItem(f.subject),
    amount: null,
  }));
}

// Matches a drawing's word for something ("reception counter") to a
// booth label ("FS - Reception Counter").
//
// Deliberately conservative. A wrong booth match points a removal at the
// wrong 25 line items, which is worse than no match at all -- an
// unmatched finding is reported to the estimator as "something changed
// and I could not tell you where", which is useful; a confidently wrong
// one is not.
export function resolveBoothLabel(subject: string, boothLabels: string[]): string | null {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/^(fs|ss)\s*-\s*/, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const want = normalize(subject);
  if (!want) return null;

  const scored = boothLabels
    .map((label) => ({ label, key: normalize(label) }))
    .filter((c) => c.key.length > 0)
    // Containment either way: "reception counter" against
    // "FS - Reception Counter", and "hitting bay wall" against a
    // finding that says "hitting bay".
    .filter((c) => c.key === want || c.key.includes(want) || want.includes(c.key));

  // Ambiguity is not a match. Two booths both plausibly named by one
  // finding means the drawing did not say which, and guessing would
  // silently pick one.
  return scored.length === 1 ? scored[0].label : null;
}

// The same conservative match against LINE ITEM descriptions.
//
// Booth matching alone is too narrow: on ABC Chicago only one of seven
// drawing findings resolved, because a rendering names things an
// estimator would call items, not booths. "hanging sign" is not a booth
// -- it is a $55,943 line item inside one, and it is the single biggest
// thing the client asked to change. Leaving it unscoped throws away the
// finding that matters most.
//
// Same discipline as resolveBoothLabel, for the same reason: a wrong
// match points a removal at the wrong line, so ambiguity resolves to
// nothing. The widening is safe because what it grants is still only the
// right to PROPOSE, with a citation, at NEED_YOUR_DECISION.
export function resolveLineItemMatch(
  subject: string,
  lineItems: { id: string; description: string }[],
): string | null {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  const want = normalize(subject);
  // Too short to match on: "sign" would hit every signage line there is.
  if (want.length < 5) return null;

  const hits = lineItems
    .map((li) => ({ id: li.id, key: normalize(li.description) }))
    .filter((c) => c.key.length > 0 && (c.key === want || c.key.includes(want)));

  if (hits.length === 0) return null;
  // Several lines matching one phrase means the drawing did not say
  // which, and every one of them is a different amount of money.
  const distinct = new Set(hits.map((h) => h.id));
  return distinct.size === 1 ? hits[0].id : null;
}

// Everything worth putting in front of the AI stage, filtered and in one
// order: what left first, because on a job being cut to a budget that is
// what is being looked for.
export function collectEvidence(all: RecostEvidence[]): RecostEvidence[] {
  const order: Record<EvidenceKind, number> = {
    DROPPED: 0,
    DESIGN_CHANGED: 1,
    QTY_CHANGED: 2,
    REPRICED: 3,
    ADDED: 4,
  };
  return all
    .filter((e) => isMaterial(e.amount, false))
    .sort((a, b) => order[a.kind] - order[b.kind] || Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0));
}
