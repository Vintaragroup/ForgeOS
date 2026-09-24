// Whether a document is still the authority for what it produced, and
// what that means for the line items hanging off it.
//
// The rule this exists to enforce, from the estimating lead: a document
// losing currency removes NOTHING from the estimate. Its line items keep
// sitting there costing money; they just stop having a current source
// behind them. They are flagged as potentially changing, not as
// candidates for deletion -- unless the client asked for a full redesign,
// which is a different mode entirely. See docs/recost-review.md.
//
// A leaf module: pure functions over plain rows, no db import.

export type DocumentValidityValue = "CURRENT" | "SUPERSEDED" | "WITHDRAWN";

export interface ValiditySource {
  id: string;
  filename: string;
  validity: DocumentValidityValue;
  validityNote: string | null;
  // Set by the revision chain rather than by hand.
  supersededByFilename: string | null;
}

// SUPERSEDED is derived, WITHDRAWN is declared.
//
// A document with something superseding it IS superseded, whatever the
// column says -- the chain is the truth and the column would drift from
// it the moment a link changed. WITHDRAWN cannot be derived from
// anything: only a person knows a vendor is off the job, so a stored
// WITHDRAWN always wins.
export function effectiveValidity(doc: {
  validity: DocumentValidityValue;
  supersededByFilename: string | null;
}): DocumentValidityValue {
  if (doc.validity === "WITHDRAWN") return "WITHDRAWN";
  if (doc.supersededByFilename) return "SUPERSEDED";
  return doc.validity;
}

export function isStaleSource(doc: { validity: DocumentValidityValue; supersededByFilename: string | null }): boolean {
  return effectiveValidity(doc) !== "CURRENT";
}

// What to tell someone looking at a line item whose source is no longer
// current. Deliberately says what IS known and stops -- it never implies
// the line is going away, because on a value-engineering job it almost
// certainly is not.
export function staleSourceExplanation(doc: ValiditySource): string | null {
  const validity = effectiveValidity(doc);
  if (validity === "CURRENT") return null;

  if (validity === "WITHDRAWN") {
    return doc.validityNote
      ? `${doc.filename} is no longer a valid source — ${doc.validityNote}`
      : `${doc.filename} is no longer a valid source.`;
  }
  return doc.supersededByFilename
    ? `${doc.filename} has been replaced by ${doc.supersededByFilename}.`
    : `${doc.filename} has been replaced.`;
}

export interface StaleGroup {
  documentId: string;
  filename: string;
  validity: DocumentValidityValue;
  explanation: string;
  lineItemCount: number;
  totalCost: number;
}

// Groups an estimate's line items by the stale source they came from.
//
// Grouped rather than listed flat because this is how the decision is
// actually made: sixteen line items from a withdrawn AV quote are one
// conversation about one vendor, not sixteen conversations. The total is
// what makes it a conversation worth having at all.
export function groupStaleLineItems(
  lineItems: { documentId: string | null; totalCost: number }[],
  documents: ValiditySource[],
): StaleGroup[] {
  const stale = new Map(documents.filter(isStaleSource).map((d) => [d.id, d]));
  const groups = new Map<string, StaleGroup>();

  for (const item of lineItems) {
    if (!item.documentId) continue;
    const doc = stale.get(item.documentId);
    if (!doc) continue;

    const existing = groups.get(doc.id);
    if (existing) {
      existing.lineItemCount += 1;
      existing.totalCost += item.totalCost;
      continue;
    }
    groups.set(doc.id, {
      documentId: doc.id,
      filename: doc.filename,
      validity: effectiveValidity(doc),
      explanation: staleSourceExplanation(doc) ?? "",
      lineItemCount: 1,
      totalCost: item.totalCost,
    });
  }

  // Biggest first: the question worth asking first is the expensive one.
  // A withdrawn source outranks a superseded one at equal money, because
  // a superseded document at least has a replacement to compare against
  // while a withdrawn one leaves a hole.
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.validity === "WITHDRAWN") - Number(a.validity === "WITHDRAWN") || b.totalCost - a.totalCost,
  );
}
