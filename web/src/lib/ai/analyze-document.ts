// Type-based dispatch point for "Analyze" -- the one place that decides
// whether a document gets the text summarizer, the vision-based drawing
// summarizer, or the meeting-notes summarizer, so document-summary-
// service.ts, drawing-summary-service.ts, and meeting-notes-summary-
// service.ts stay one-directional (none imports another) and every call
// site (documents/actions.ts today, anything else later) branches the
// same way.

import { db } from "@/lib/db";
import { summarizeDocument, type DocumentSummary } from "@/lib/ai/document-summary-service";
import { summarizeDrawing } from "@/lib/ai/drawing-summary-service";
import { summarizeMeetingNotes } from "@/lib/ai/meeting-notes-summary-service";
import { applyExtractedFieldsToOpportunity } from "@/lib/opportunity-service";

export async function analyzeDocument(documentId: string, userId: string | null = null) {
  const { documentType, opportunityId } = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { documentType: true, opportunityId: true },
  });
  const result =
    documentType === "DRAWING"
      ? await summarizeDrawing(documentId, userId)
      : documentType === "MEETING_NOTES"
        ? await summarizeMeetingNotes(documentId, userId)
        : await summarizeDocument(documentId, userId);

  // Only summarizeDocument (never summarizeDrawing) ever populates
  // extractedFields -- see document-summary-service.ts. A failed/
  // unsupported analysis leaves extractedSummary as whatever it was
  // before (null on a first attempt), so this is a no-op in that case,
  // not an error.
  const summary = result.extractedSummary as unknown as DocumentSummary | null;
  if (summary?.extractedFields?.length) {
    await applyExtractedFieldsToOpportunity(opportunityId, summary.extractedFields);
  }

  return result;
}
