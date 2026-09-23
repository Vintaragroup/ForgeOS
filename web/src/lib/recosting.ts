// Where a re-costing stands, as one answer.
//
// The task behind this is one sentence -- "the client wants a lower
// number, here is the new pricing, tell me what changed" -- and ForgeOS
// used to spread it across four manual actions on two pages: upload, set
// the type, pick what it replaces from a list of every document, click
// Analyze. Then the result appeared on the Opportunity while the line
// items it was about lived on the Estimate. Every step failed silently:
// a document could sit unanalyzed for weeks and nothing said so.
//
// So the page stops asking the reader to assemble that. This works out
// which single step is actually next and says only that.
//
// A leaf module: pure functions over plain rows, no db import, so the
// card can be a client component without pulling Prisma into the bundle.

export type ExtractionStatusLike = "PENDING" | "ANALYZING" | "COMPLETE" | "FAILED" | "UNSUPPORTED";

// The types a price can be read out of. A drawing or a scope writeup has
// nothing to compare, which is why they are not candidates here -- same
// exclusion diffDocumentAgainstPredecessor makes for the same reason.
const PRICED_TYPES = new Set(["PRICING_SCHEDULE", "VENDOR_QUOTE"]);

export function isPricedDocumentType(documentType: string): boolean {
  return PRICED_TYPES.has(documentType);
}

export interface RecostingDocument {
  id: string;
  filename: string;
  documentType: string;
  extractionStatus: ExtractionStatusLike;
  supersedesId: string | null;
  supersedesFilename: string | null;
  createdAt: Date;
  // Whether analysis actually produced rows carrying a price. Distinct
  // from extractionStatus COMPLETE: a document can finish extraction and
  // still yield nothing priced, and "no changes" would then be a
  // confident lie about a document nothing could be read out of.
  hasPricedRows: boolean;
}

export interface RecostingInput {
  // Null when there is no proposal at all.
  proposalStatus: string | null;
  // The client's own words, from the REVISIONS_REQUESTED event. This is
  // the reason the whole card exists, so it leads.
  request: { note: string | null; at: Date } | null;
  // The version the revised pricing is meant to land in. Null when
  // nothing is open for editing.
  openVersion: { id: string; versionNumber: number } | null;
  documents: RecostingDocument[];
}

export type RecostingState =
  // Not in a re-costing at all -- the card does not render.
  | { kind: "NONE" }
  // A change was requested but nothing has been uploaded against it yet.
  | { kind: "AWAITING_DOCUMENT"; versionNumber: number; request: RecostingInput["request"] }
  // Uploaded and linked, but nothing readable has come out of it yet.
  | {
      kind: "AWAITING_ANALYSIS";
      versionNumber: number;
      request: RecostingInput["request"];
      document: RecostingDocument;
    }
  // Analysis ran and produced nothing usable. Says so rather than
  // reading as "no changes".
  | {
      kind: "ANALYSIS_FAILED";
      versionNumber: number;
      request: RecostingInput["request"];
      document: RecostingDocument;
    }
  // There is something to read.
  | {
      kind: "READY";
      versionNumber: number;
      request: RecostingInput["request"];
      document: RecostingDocument;
    };

export function resolveRecostingState(input: RecostingInput): RecostingState {
  if (input.proposalStatus !== "REVISIONS_REQUESTED") return { kind: "NONE" };
  // Nothing open to re-cost into. Prompting for a revised price with
  // nowhere to put it would be an instruction that can't be followed.
  if (!input.openVersion) return { kind: "NONE" };

  const versionNumber = input.openVersion.versionNumber;
  const request = input.request;

  // The revised document is one that (a) can carry prices, (b) says what
  // it replaces, and (c) arrived after the client asked. The supersedes
  // link is what makes it a revision rather than just another upload,
  // and the date is what stops an older revision pair being mistaken for
  // an answer to THIS request.
  const candidates = input.documents
    .filter((d) => isPricedDocumentType(d.documentType))
    .filter((d) => d.supersedesId)
    .filter((d) => !request || d.createdAt.getTime() >= request.at.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const document = candidates[0];
  if (!document) return { kind: "AWAITING_DOCUMENT", versionNumber, request };

  if (document.extractionStatus === "FAILED" || document.extractionStatus === "UNSUPPORTED") {
    return { kind: "ANALYSIS_FAILED", versionNumber, request, document };
  }
  // COMPLETE without priced rows is still nothing to compare -- see
  // hasPricedRows.
  if (!document.hasPricedRows) {
    return { kind: "AWAITING_ANALYSIS", versionNumber, request, document };
  }
  return { kind: "READY", versionNumber, request, document };
}

// One line naming the single next action, in the reader's terms rather
// than the system's. Pairs with the state above so the card never has to
// decide what to say.
export function recostingNextStep(state: RecostingState): string | null {
  switch (state.kind) {
    case "NONE":
      return null;
    case "AWAITING_DOCUMENT":
      return "Upload the revised pricing to see what changed.";
    case "AWAITING_ANALYSIS":
      return "Reading it now — nothing can be compared until this finishes.";
    case "ANALYSIS_FAILED":
      return "This file couldn't be read, so nothing can be compared against it.";
    case "READY":
      return "Review what changed, then apply it to this version.";
  }
}
