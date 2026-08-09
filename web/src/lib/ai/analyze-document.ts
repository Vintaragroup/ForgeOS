// Type-based dispatch point for "Analyze" -- the one place that decides
// whether a document gets the text summarizer or the vision-based drawing
// summarizer, so document-summary-service.ts and drawing-summary-service.ts
// stay one-directional (neither imports the other) and every call site
// (documents/actions.ts today, anything else later) branches the same way.

import { db } from "@/lib/db";
import { summarizeDocument } from "@/lib/ai/document-summary-service";
import { summarizeDrawing } from "@/lib/ai/drawing-summary-service";

export async function analyzeDocument(documentId: string, userId: string | null = null) {
  const { documentType } = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { documentType: true },
  });
  return documentType === "DRAWING" ? summarizeDrawing(documentId, userId) : summarizeDocument(documentId, userId);
}
