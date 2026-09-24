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

// A pricing schedule is not a priced document, despite the name. Its
// parser reads category/item/description/unit/qty and no price at all --
// the cost comes from the catalog at import. So it can be compared on
// scope, never on money, and it has no analysis step to wait for. See
// scope-diff.ts.
export function isScheduleDocumentType(documentType: string): boolean {
  return documentType === "PRICING_SCHEDULE";
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
  // A revised schedule, which needs importing rather than analysing --
  // and whose comparison is scope, not money.
  | {
      kind: "READY_TO_IMPORT";
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

  // The revised document is one that can carry a revision -- a priced
  // type that says what it replaces. The supersedes link is what makes
  // it a revision rather than just another upload.
  //
  // Deliberately NOT filtered to documents uploaded after the request.
  // That was the obvious rule and it is backwards: in practice the
  // revised file arrives first and the client's request gets logged when
  // somebody gets to it. On ABC Chicago the spreadsheet landed at 17:46
  // and the request was recorded at 22:01, four hours later, so filtering
  // by date hid the very document the card exists to talk about and told
  // the reader to upload a file that was already sitting there.
  const candidates = input.documents
    .filter((d) => isPricedDocumentType(d.documentType))
    .filter((d) => d.supersedesId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const document = candidates[0];
  if (!document) return { kind: "AWAITING_DOCUMENT", versionNumber, request };

  // A spreadsheet never goes through analysis at all, so it is never
  // waiting for one. ForgeOS parses a workbook on demand at import and
  // stores nothing on the document, which is why a PRICING_SCHEDULE sits
  // at PENDING with zero parsed rows forever -- that is its correct
  // resting state, not a stuck job. Sending it down the analysis branch
  // parks it on "being read now" for good.
  if (isScheduleDocumentType(document.documentType)) {
    return { kind: "READY_TO_IMPORT", versionNumber, request, document };
  }

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
    case "READY_TO_IMPORT":
      return "See what the client changed, then import it into this version.";
    case "READY":
      return "Review what changed, then apply it to this version.";
  }
}
