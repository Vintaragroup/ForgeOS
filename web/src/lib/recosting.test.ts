import { describe, expect, it } from "vitest";
import { isPricedDocumentType, recostingNextStep, resolveRecostingState, type RecostingDocument } from "@/lib/recosting";

const REQUESTED_AT = new Date("2026-09-23T22:00:00Z");

function doc(over: Partial<RecostingDocument> = {}): RecostingDocument {
  return {
    id: "d1",
    // A vendor quote by default: it really does carry prices, so it
    // exercises the analysis branch. The schedule branch is asserted
    // explicitly in its own test.
    filename: "369711-Version-2-Expo-CCI.pdf",
    documentType: "VENDOR_QUOTE",
    extractionStatus: "COMPLETE",
    supersedesId: "old",
    supersedesFilename: "ABCA_2027_Exhibit_Cost_Breakout.xlsx",
    createdAt: new Date("2026-09-23T22:30:00Z"),
    hasPricedRows: true,
    ...over,
  };
}

function input(over: Partial<Parameters<typeof resolveRecostingState>[0]> = {}) {
  return {
    proposalStatus: "REVISIONS_REQUESTED",
    request: { note: "Get it to 250k.", at: REQUESTED_AT },
    openVersion: { id: "v2", versionNumber: 2 },
    documents: [doc()],
    ...over,
  };
}

describe("resolveRecostingState", () => {
  it("says nothing at all unless the client has actually asked for a change", () => {
    for (const status of ["DRAFT", "SENT", "UNDER_REVIEW", "SIGNED", "DECLINED", null]) {
      expect(resolveRecostingState(input({ proposalStatus: status })).kind).toBe("NONE");
    }
  });

  // Prompting for revised pricing with nowhere to put it is an
  // instruction that cannot be followed.
  it("says nothing when no version is open to re-cost into", () => {
    expect(resolveRecostingState(input({ openVersion: null })).kind).toBe("NONE");
  });

  it("asks for the document when nothing has been uploaded against the request", () => {
    const state = resolveRecostingState(input({ documents: [] }));
    expect(state.kind).toBe("AWAITING_DOCUMENT");
    expect(recostingNextStep(state)).toMatch(/Upload the revised pricing/);
  });

  // The whole point of the card is the diff, and a document that
  // replaces nothing has nothing to be compared against.
  it("ignores an upload that doesn't say what it replaces", () => {
    const state = resolveRecostingState(input({ documents: [doc({ supersedesId: null })] }));
    expect(state.kind).toBe("AWAITING_DOCUMENT");
  });

  it("ignores a drawing or a scope writeup, which carry no prices", () => {
    for (const documentType of ["DRAWING", "SCOPE_OF_WORK", "MEETING_NOTES", "OTHER"]) {
      expect(resolveRecostingState(input({ documents: [doc({ documentType })] })).kind).toBe("AWAITING_DOCUMENT");
    }
    expect(isPricedDocumentType("PRICING_SCHEDULE")).toBe(true);
    expect(isPricedDocumentType("VENDOR_QUOTE")).toBe(true);
    expect(isPricedDocumentType("DRAWING")).toBe(false);
  });

  // The revised file almost always arrives BEFORE the request is logged:
  // someone uploads what the client sent, then records the ask when they
  // get to it. On ABC Chicago that gap was four hours, and filtering by
  // date hid the very document the card exists to talk about.
  it("uses a revision uploaded before the request was logged", () => {
    const state = resolveRecostingState(
      input({ documents: [doc({ createdAt: new Date("2026-09-23T17:46:00Z") })] }),
    );
    expect(state.kind).toBe("READY");
  });

  it("waits while a linked document still has nothing priced in it", () => {
    // Exactly ABC Chicago: uploaded, linked, and sitting PENDING with
    // zero parsed rows while nothing said so.
    const state = resolveRecostingState(
      input({ documents: [doc({ extractionStatus: "PENDING", hasPricedRows: false })] }),
    );
    expect(state.kind).toBe("AWAITING_ANALYSIS");
    expect(recostingNextStep(state)).toMatch(/nothing can be compared/);
  });

  // COMPLETE is not the same as readable. Treating it as such is how a
  // document nothing could be read out of reports "no changes".
  it("treats a finished extraction with no priced rows as still not readable", () => {
    const state = resolveRecostingState(
      input({ documents: [doc({ extractionStatus: "COMPLETE", hasPricedRows: false })] }),
    );
    expect(state.kind).toBe("AWAITING_ANALYSIS");
  });

  it("says so plainly when the file could not be read", () => {
    for (const extractionStatus of ["FAILED", "UNSUPPORTED"] as const) {
      const state = resolveRecostingState(input({ documents: [doc({ extractionStatus, hasPricedRows: false })] }));
      expect(state.kind).toBe("ANALYSIS_FAILED");
      expect(recostingNextStep(state)).toMatch(/couldn't be read/);
    }
  });

  // The bug that made the card useless for the case it was built for: a
  // PRICING_SCHEDULE never goes through analysis, so it sits at PENDING
  // with zero parsed rows forever. Treating that as "being read now"
  // parks the card on a step that will never complete.
  it("sends a revised schedule to import rather than waiting on an analysis it never gets", () => {
    const state = resolveRecostingState(
      input({
        documents: [doc({ documentType: "PRICING_SCHEDULE", extractionStatus: "PENDING", hasPricedRows: false })],
      }),
    );
    expect(state.kind).toBe("READY_TO_IMPORT");
    expect(recostingNextStep(state)).toMatch(/import it/i);
  });

  // A vendor quote PDF really does carry prices, so it keeps the
  // analysis branch.
  it("still waits on analysis for a vendor quote, which does carry prices", () => {
    const state = resolveRecostingState(
      input({
        documents: [doc({ documentType: "VENDOR_QUOTE", extractionStatus: "PENDING", hasPricedRows: false })],
      }),
    );
    expect(state.kind).toBe("AWAITING_ANALYSIS");
  });

  it("is ready once a linked document has priced rows, and names it", () => {
    const state = resolveRecostingState(input());
    expect(state.kind).toBe("READY");
    if (state.kind !== "READY") return;
    expect(state.document.filename).toBe("369711-Version-2-Expo-CCI.pdf");
    expect(state.document.supersedesFilename).toBe("ABCA_2027_Exhibit_Cost_Breakout.xlsx");
    expect(state.versionNumber).toBe(2);
    expect(state.request?.note).toBe("Get it to 250k.");
  });

  it("takes the newest revision when several were uploaded against one request", () => {
    const state = resolveRecostingState(
      input({
        documents: [
          doc({ id: "first", filename: "first.pdf", createdAt: new Date("2026-09-23T22:10:00Z") }),
          doc({ id: "second", filename: "second.pdf", createdAt: new Date("2026-09-23T23:00:00Z") }),
        ],
      }),
    );
    expect(state.kind).toBe("READY");
    if (state.kind !== "READY") return;
    expect(state.document.id).toBe("second");
  });

  it("works with no recorded request time at all", () => {
    const state = resolveRecostingState(
      input({ request: null, documents: [doc({ createdAt: new Date("2020-01-01T00:00:00Z") })] }),
    );
    expect(state.kind).toBe("READY");
  });
});
