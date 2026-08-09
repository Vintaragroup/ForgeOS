// Phase 7.2: one Structured Outputs call per text-bearing document,
// producing a fixed JSON shape rather than free-form prose -- so the
// Project Brief panel (opportunities/[id]/page.tsx) can render it without
// re-parsing an LLM's prose output. See data/RFP/superbowl for the real
// documents this schema was designed against: the RFP's own key dates
// (Appendix A), Schedule A's scope bullets, and the Vendor Services
// Agreement's liquidated-damages/insurance risk terms.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { extractDocumentText } from "@/lib/ai/text-extraction";
import { DEFAULT_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";

export interface DocumentSummary {
  eventOrProjectName: string | null;
  venue: string | null;
  submissionDeadline: string | null;
  keyDates: { label: string; date: string }[];
  scopeSummary: string[];
  riskFlags: string[];
}

const SUMMARY_SCHEMA = {
  name: "document_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      eventOrProjectName: { type: ["string", "null"] },
      venue: { type: ["string", "null"] },
      submissionDeadline: { type: ["string", "null"], description: "Free-text date, as written in the source." },
      keyDates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { label: { type: "string" }, date: { type: "string" } },
          required: ["label", "date"],
        },
      },
      scopeSummary: { type: "array", items: { type: "string" } },
      riskFlags: {
        type: "array",
        items: { type: "string" },
        description: "Contract/compliance risks worth a human's attention -- liquidated damages, insurance minimums, credentialing deadlines, etc.",
      },
    },
    required: ["eventOrProjectName", "venue", "submissionDeadline", "keyDates", "scopeSummary", "riskFlags"],
  },
} as const;

const SYSTEM_PROMPT = `You analyze RFP and client-supplied project documents for an event/exhibit contractor. Extract only facts stated in the document -- never infer or guess a date, name, or figure that isn't written there. If something isn't present, use null or an empty array. Keep scopeSummary and riskFlags as short, specific bullet points, not paragraphs.`;

// Truncated, not chunked -- this app has no RAG/embedding infra (see
// chat-context-service.ts's same budget approach), and a single document's
// text staying under this is true for every real sample in
// data/RFP/superbowl.
const MAX_INPUT_CHARS = 60_000;

export async function summarizeDocument(documentId: string) {
  const { document, bytes } = await getDocumentBytes(documentId);

  // Type-based UNSUPPORTED cases (PRICING_SCHEDULE, DRAWING) never call
  // OpenAI at all -- resolved before the config check below so they work
  // regardless of whether a key is configured.
  const extraction = await extractDocumentText(document.documentType, document.mimeType, bytes);

  if (extraction.status === "UNSUPPORTED") {
    return db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "UNSUPPORTED", extractedText: null },
    });
  }

  // Checked before any DB write for a text-bearing document -- a missing
  // key is a configuration problem the caller surfaces distinctly (see
  // analyzeDocumentAction), and must leave the document exactly as it was
  // (PENDING, retryable) rather than stuck at PROCESSING with no Analyze
  // button to try again once a key is added.
  const client = getOpenAiClient();

  await db.document.update({
    where: { id: documentId },
    data: { extractionStatus: "PROCESSING", extractedText: extraction.text.slice(0, MAX_INPUT_CHARS) },
  });

  try {
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Document: ${document.filename}\n\n${extraction.text.slice(0, MAX_INPUT_CHARS)}` },
      ],
      response_format: { type: "json_schema", json_schema: SUMMARY_SCHEMA },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response.");
    const summary = JSON.parse(content) as DocumentSummary;

    return db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "COMPLETE", extractedSummary: summary as unknown as Prisma.InputJsonObject },
    });
  } catch {
    // A transient/API failure is retryable by clicking Analyze again --
    // record it as FAILED rather than throwing, so the Server Action
    // completes normally and the UI reflects it via the status chip.
    // instrumentation.ts's onRequestError hook deliberately won't see
    // this: a per-document analysis failure isn't a request-level error.
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
}
