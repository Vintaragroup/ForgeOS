// Framework-agnostic document ingestion, kept separate from any
// app/opportunities/documents/actions.ts the same way estimate-service.ts
// is kept separate from app/estimates/actions.ts (see that file's header
// comment). Phase 7: data/RFP/superbowl's two real RFP packages are this
// feature's roadmap.

import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { validateSupersedes } from "@/lib/document-revisions";
import { computeDocumentDiff, type DiffableRow } from "@/lib/document-diff";
import { Prisma } from "@/generated/prisma/client";
import type { DocumentType } from "@/generated/prisma/enums";
import { buildStorageKey, deleteObject, getObject, headPrivateObject, putObject } from "@/lib/storage";

// Exported: documents/upload/route.ts's onBeforeGenerateToken enforces the
// same two rules (extension, size) before it ever issues a client upload
// token, for the direct-to-Blob path -- see that file's header comment for
// why the check has to happen there too, not just here.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB -- see next.config.ts's bodySizeLimit comment

// Native CAD/BIM formats aren't parseable without a heavy proprietary
// SDK -- out of scope by design (see Phase 7 plan). Real-world CAD content
// arrives as a PDF/image export in practice (confirmed against both real
// RFP packages in data/RFP/superbowl), which this app CAN read. Rejecting
// these extensions up front gives a clear message instead of silently
// storing a file nothing will ever extract text or a summary from.
export const UNSUPPORTED_EXTENSIONS = [".dwg", ".dxf", ".rvt", ".skp"];

export async function uploadDocument(
  opportunityId: string,
  data: { file: File; documentType: DocumentType; uploadedById?: string | null },
) {
  if (data.file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB upload limit.`);
  }

  const lowerName = data.file.name.toLowerCase();
  if (UNSUPPORTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    throw new Error(
      `Native CAD files (${UNSUPPORTED_EXTENSIONS.join(", ")}) can't be read by this app. Upload a PDF or image export of the drawing instead.`,
    );
  }

  const bytes = Buffer.from(await data.file.arrayBuffer());
  const storageKey = buildStorageKey(opportunityId, data.file.name);
  await putObject(storageKey, bytes);

  return db.document.create({
    data: {
      opportunityId,
      filename: data.file.name,
      mimeType: data.file.type || "application/octet-stream",
      sizeBytes: bytes.byteLength,
      storageKey,
      documentType: data.documentType,
      uploadedById: data.uploadedById ?? null,
    },
  });
}

// Counterpart to uploadDocument for the direct-to-Blob path (documents/
// upload/route.ts + document-upload-form.tsx): the file's bytes already
// live in Blob by the time this runs -- the browser uploaded them straight
// there, never through this server at all, which is the whole point (see
// next.config.ts's bodySizeLimit comment on why routing large files through
// a Server Action's own body doesn't scale). This only needs to verify the
// blob and record it, mirroring uploadDocument's db.document.create shape.
// storageKey is trusted here only because documents/upload/route.ts's
// onBeforeGenerateToken already required it to start with
// `${opportunityId}/` before a token was ever issued for it -- re-checked
// here too since this function has its own callers.
export async function finalizeUploadedDocument(
  opportunityId: string,
  data: { storageKey: string; filename: string; documentType: DocumentType; uploadedById?: string | null },
) {
  if (!data.storageKey.startsWith(`${opportunityId}/`)) {
    throw new Error("Storage key doesn't belong to this opportunity.");
  }

  const { size, contentType } = await headPrivateObject(data.storageKey);

  return db.document.create({
    data: {
      opportunityId,
      filename: data.filename,
      mimeType: contentType || "application/octet-stream",
      sizeBytes: size,
      storageKey: data.storageKey,
      documentType: data.documentType,
      uploadedById: data.uploadedById ?? null,
    },
  });
}

export async function listDocuments(opportunityId: string) {
  return db.document.findMany({
    where: { opportunityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      uploadedBy: { select: { name: true } },
      // The document this one replaces, by name -- every revision row on
      // the Opportunity shows "replaces X", and a drawing comparison
      // needs it to label which design it was compared against.
      supersedes: { select: { id: true, filename: true } },
    },
  });
}

// Row only, no storage read -- for callers (the /view page's PDF branch)
// that only need filename/mimeType and hand the byte-serving off to the
// raw-bytes route instead of loading a possibly-large file into memory
// just to discard it.
export async function getDocument(documentId: string) {
  return db.document.findFirstOrThrow({ where: { id: documentId, deletedAt: null } });
}

export async function getDocumentBytes(documentId: string) {
  const document = await db.document.findFirstOrThrow({ where: { id: documentId, deletedAt: null } });
  const bytes = await getObject(document.storageKey);
  return { document, bytes };
}

// Soft-delete only, mirroring Attachment -- the on-disk bytes are removed
// immediately (there's no benefit to keeping them once the record is
// gone, unlike the DB row which stays for audit/history purposes).
//
// opportunityId is the caller's already-access-checked opportunity (from
// requireOpportunityAccess), NOT trusted from documentId alone -- see
// [documentId]/route.ts's own header comment for the exact vulnerability
// class this guards against: a documentId is an opaque, guessable/
// enumerable string, and without confirming it actually belongs to the
// opportunity the caller was authorized for, any authenticated user could
// mutate another company's document by ID alone. findFirstOrThrow with
// both id AND opportunityId in the where clause does the ownership check
// and the existence check in one query, the same pattern cut-list's
// addCutListPartAction already uses for a lineItemId.
export async function deleteDocument(opportunityId: string, documentId: string) {
  const existing = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId, deletedAt: null } });
  const document = await db.document.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
  });
  await deleteObject(document.storageKey);
  return document;
}

// A wrong documentType silently sends a file down the wrong pipeline --
// e.g. a Pricing Schedule .xlsx tagged RFP goes through the text
// summarizer instead of the deterministic XLSX parser and comes back
// UNSUPPORTED (see opportunities/[id]/page.tsx's mistagged-spreadsheet
// warning). Whatever was already extracted under the old (wrong)
// assumption is reset back to PENDING rather than left stale, so the
// document reads as "needs analysis again," not as already analyzed
// under the type it's about to stop being.
// opportunityId ownership check -- see deleteDocument's header comment.
export async function updateDocumentType(opportunityId: string, documentId: string, documentType: DocumentType) {
  const existing = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId, deletedAt: null } });
  return db.document.update({
    where: { id: existing.id },
    data: {
      documentType,
      extractionStatus: "PENDING",
      extractedText: null,
      extractedSummary: Prisma.DbNull,
      proposedLineItems: Prisma.DbNull,
    },
  });
}

// Same reset posture as updateDocumentType above -- whatever was already
// extracted was classified (or not) under the OLD estimate assignment,
// so it's stale the moment that assignment changes, not just cosmetically
// out of date. estimateId null clears a manual tag, reverting the
// document back to AI classification at fact level (see document-
// summary-service.ts's own estimateId resolution).
// opportunityId ownership check -- see deleteDocument's header comment.
export async function assignDocumentEstimate(opportunityId: string, documentId: string, estimateId: string | null) {
  const existing = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId, deletedAt: null } });
  return db.document.update({
    where: { id: existing.id },
    data: {
      estimateId,
      extractionStatus: "PENDING",
      extractedText: null,
      extractedSummary: Prisma.DbNull,
      proposedLineItems: Prisma.DbNull,
    },
  });
}

// Unlike updateDocumentType/assignDocumentEstimate above, this does NOT
// reset extractionStatus/extractedText -- proposeVendorQuoteLineItems
// extracts whatever priced lines are in the document's text regardless
// of which BidPackage it ends up attached to, so which package a
// VENDOR_QUOTE document belongs to has no bearing on how it gets read.
// opportunityId ownership check -- see deleteDocument's header comment.
export async function assignDocumentBidPackage(opportunityId: string, documentId: string, bidPackageId: string | null) {
  const existing = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId, deletedAt: null } });
  return db.document.update({ where: { id: existing.id }, data: { bidPackageId } });
}

// Records that one document replaces another. The version label is then
// derived from the chain rather than typed in -- see
// document-revisions.ts for why that distinction matters.
//
// Both documents must be on the same opportunity: a revision chain that
// reached across deals would let one client's pricing supersede another's.
export async function setDocumentSupersedes(
  opportunityId: string,
  documentId: string,
  supersedesId: string | null,
) {
  const documents = await db.document.findMany({
    where: { opportunityId, deletedAt: null },
    select: { id: true, filename: true, supersedesId: true, createdAt: true },
  });
  if (!documents.some((d) => d.id === documentId)) {
    throw new UserError("That document isn't on this opportunity.");
  }
  const problem = validateSupersedes(documents, documentId, supersedesId);
  if (problem) throw new UserError(problem);

  await db.document.update({ where: { id: documentId }, data: { supersedesId } });
}


// Pulls priced rows out of whichever field holds them, and refuses to
// invent a price where there isn't one.
//
// Both shapes are stored as loose JSON, so this reads them structurally
// rather than trusting a type assertion: a vendor quote line carries
// `unitPrice`, an imported spreadsheet row carries `unitCost`, and a
// scope-analysis row carries neither. A row without a usable number is
// dropped rather than counted as free -- one $0 row in a diff reads as
// "the vendor gave this away", which is worse than not showing it.
function extractPricedRows(vendorQuoteLineItems: unknown, proposedLineItems: unknown): DiffableRow[] {
  const read = (raw: unknown, priceKey: "unitPrice" | "unitCost"): DiffableRow[] => {
    if (!Array.isArray(raw)) return [];
    const rows: DiffableRow[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const description = typeof row.description === "string" ? row.description : null;
      const price = row[priceKey];
      if (!description || typeof price !== "number" || !Number.isFinite(price)) continue;
      // A line with no quantity of its own is one of something, which is
      // how the rest of the pipeline already reads it.
      const qty = typeof row.qty === "number" && Number.isFinite(row.qty) ? row.qty : 1;
      rows.push({ description, qty, unitCost: price });
    }
    return rows;
  };

  const fromQuote = read(vendorQuoteLineItems, "unitPrice");
  // Quote extraction wins where both exist: it is the more specific
  // reading of the two, run deliberately against a known vendor document.
  return fromQuote.length > 0 ? fromQuote : read(proposedLineItems, "unitCost");
}

// Whether analysis has actually produced anything with a price on it.
//
// Distinct from extractionStatus === "COMPLETE": a document can finish
// extraction and still yield nothing priced (a scope writeup read as
// proposed items, a spreadsheet whose price column was not recognised).
// Treating COMPLETE as readable is how a document nothing could be read
// out of ends up reporting "no changes".
export function documentHasPricedRows(vendorQuoteLineItems: unknown, proposedLineItems: unknown): boolean {
  return extractPricedRows(vendorQuoteLineItems, proposedLineItems).length > 0;
}

// What a revised document changes against the one it replaces.
//
// Compares the new document's extracted vendor-quote lines against the
// LINE ITEMS THE PREVIOUS DOCUMENT PRODUCED -- which is only possible
// because LineItem.documentId records where each row came from. That
// provenance was being destroyed on every new estimate version until
// lineItemCreateData was fixed; this is what it was for.
//
// Deliberately compares against a scope narrower than the whole estimate.
// "12 things changed somewhere in this estimate" is not actionable;
// "your AV vendor dropped 3 lines and raised 4 prices" is, and scoping to
// one vendor's own previous rows is also what makes a REMOVED row
// trustworthy enough to act on rather than merely note.
export async function diffDocumentAgainstPredecessor(opportunityId: string, documentId: string) {
  const doc = await db.document.findFirst({
    where: { id: documentId, opportunityId, deletedAt: null },
    select: {
      id: true,
      filename: true,
      supersedesId: true,
      documentType: true,
      vendorQuoteLineItems: true,
      proposedLineItems: true,
    },
  });
  if (!doc) throw new UserError("That document isn't on this opportunity.");
  if (!doc.supersedesId) return null;
  // A drawing or a scope writeup has no prices to compare, so prompting
  // someone to analyse one "to see what changed" is an instruction that
  // can never pay off.
  if (doc.documentType === "DRAWING" || doc.documentType === "SCOPE_OF_WORK" || doc.documentType === "MEETING_NOTES") {
    return null;
  }

  const predecessor = await db.document.findFirst({
    where: { id: doc.supersedesId, deletedAt: null },
    select: { id: true, filename: true },
  });
  if (!predecessor) return null;

  // A document's prices land in one of two places depending on how it was
  // read, and the diff has to accept both or it silently only works for
  // documents that happened to go through a bid package:
  //
  //   vendorQuoteLineItems -- a vendor quote extracted via a bid package
  //   proposedLineItems    -- a pricing spreadsheet, imported
  //
  // proposedLineItems is ALSO where scope and drawing analysis put their
  // results, and those carry no price at all. Diffing them would read
  // every row as $0 and report a whole quote as zeroed out, so the rows
  // are only used when they actually carry a unit cost.
  const lines = extractPricedRows(doc.vendorQuoteLineItems, doc.proposedLineItems);
  // Nothing priced yet is not the same as nothing changed -- saying "no
  // changes" here would be a confident lie about a document nobody has
  // read.
  if (lines.length === 0) {
    return { predecessor, extracted: false as const, diff: null };
  }

  const previousRows = await db.lineItem.findMany({
    where: { documentId: predecessor.id, section: { estimateVersion: { isCurrent: true } } },
    select: { description: true, qty: true, unitCost: true },
  });

  const diff = computeDocumentDiff(
    previousRows.map((r) => ({ description: r.description, qty: r.qty.toNumber(), unitCost: r.unitCost.toNumber() })),
    lines,
  );
  return { predecessor, extracted: true as const, diff };
}
