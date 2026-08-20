// Companion to document-summary-service.ts for DRAWING documents --
// CAD-exported PDFs and raw photographed/scanned drawings carry their
// content as vector geometry or a picture, not extractable text, so the
// input pipeline and prompt here are genuinely different (rasterize-or-
// pass-through images, vision content parts) rather than a variant of the
// text summarizer. Reuses that file's DocumentSummary/CitedText/
// KeyDateFact/KeyDateType shapes one-directionally, so ProjectBriefCard
// (opportunities/[id]/page.tsx) needs zero changes to render either kind.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import type { DocumentSummary, KeyDateType } from "@/lib/ai/document-summary-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";
import { ensureCanvasFontsRegistered } from "@/lib/canvas-fonts";

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg"];

// Bounds cost, not accuracy -- raised from 5 after a real 11-page CAD PDF
// only had its first 5 pages analyzed and missed real, later-page facts.
// Roughly doubles the realistic per-drawing vision-call cost ceiling
// (~$0.013 at 4-5 images -> ~$0.025-0.03 at 10), worth it against missing
// content entirely. Configurable so a package that genuinely needs more
// sheets analyzed isn't hard-blocked.
const MAX_DRAWING_PAGES = Number(process.env.AI_DRAWING_MAX_PAGES) || 10;

type DrawingItemFromAI = { text: string; pageNumber: number };
type DrawingKeyDateFromAI = { label: string; date: string; dateType: KeyDateType; pageNumber: number };

type DrawingSummaryFromAI = {
  eventOrProjectName: string | null;
  venue: string | null;
  submissionDeadline: string | null;
  keyDates: DrawingKeyDateFromAI[];
  scopeSummary: DrawingItemFromAI[];
  riskFlags: DrawingItemFromAI[];
};

const DRAWING_SCHEMA = {
  name: "drawing_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      eventOrProjectName: { type: ["string", "null"] },
      venue: { type: ["string", "null"] },
      submissionDeadline: { type: ["string", "null"] },
      keyDates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            date: { type: "string" },
            dateType: { type: "string", enum: ["DEADLINE", "MILESTONE", "INFORMATIONAL"] },
            pageNumber: {
              type: "integer",
              description: "1-indexed position of the image (in the order provided) where this was seen.",
            },
          },
          required: ["label", "date", "dateType", "pageNumber"],
        },
      },
      scopeSummary: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description:
                "A specific dimension, material, construction method, or fabrication detail visibly labeled or dimensioned on the sheet -- not a generic paraphrase of the whole drawing.",
            },
            pageNumber: { type: "integer", description: "1-indexed position of the image where this was seen." },
          },
          required: ["text", "pageNumber"],
        },
      },
      riskFlags: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description:
                "A structural, load, code/compliance, or ADA-clearance callout worth a human's attention -- or an engineer's stamp / a revision marked hold or not-for-construction.",
            },
            pageNumber: { type: "integer" },
          },
          required: ["text", "pageNumber"],
        },
      },
    },
    required: ["eventOrProjectName", "venue", "submissionDeadline", "keyDates", "scopeSummary", "riskFlags"],
  },
} as const;

const SYSTEM_PROMPT = `You are looking at page images of a fabrication/construction drawing or CAD export for an event/exhibit contractor. Extract only what's visibly labeled or dimensioned on the sheets -- never infer a dimension, material, or date that isn't actually printed or drawn. If nothing relevant is present, use null or an empty array.

scopeSummary: specific, sheet-grounded facts a bidder needs to price the work -- dimensions, materials called out, construction/assembly methods, finish notes. Not a generic description of "a booth drawing."
riskFlags: anything a reviewer should double-check before bidding -- structural/load callouts, code/compliance notes, ADA clearances, an engineer's stamp, or a revision marked "hold"/"not for construction."
keyDates: almost always empty -- only populate if an actual date is printed on the sheet (e.g. a title-block revision date or issue date). Never invent a submission deadline from a drawing; that belongs to the RFP text, not this document.

Extract every distinct dimension, material, price, and callout you can find on each sheet, not just the most prominent ones -- a second look at the same sheet should find just as much as the first. Err toward including a borderline item rather than omitting it.

For every item, report pageNumber: the 1-indexed position of the image (in the order provided) where you saw it -- your actual position in the list you were given, not a guess.`;

// Exported for direct testing of the mime-branching logic -- this part
// needs only unpdf, not OpenAI, so it can run for real in CI (see
// drawing-summary-service.test.ts).
export async function pageImages(mimeType: string, bytes: Buffer): Promise<string[]> {
  if (IMAGE_MIMES.includes(mimeType)) {
    return [`data:${mimeType};base64,${bytes.toString("base64")}`];
  }
  if (mimeType === PDF_MIME) {
    // Same missing-glyph gap as document-view-service.ts's highlighted-
    // page render, one level more consequential here: this image is what
    // the vision model actually reads for dimensions/labels/callouts
    // (SYSTEM_PROMPT above), so text silently failing to rasterize on
    // Vercel doesn't just look wrong -- it starves the AI extraction of
    // everything the drawing's own labels say, sheet by sheet.
    ensureCanvasFontsRegistered();
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const pageCount = Math.min(pdf.numPages, MAX_DRAWING_PAGES);
    const images: string[] = [];
    for (let page = 1; page <= pageCount; page++) {
      images.push(
        await renderPageAsImage(pdf, page, {
          toDataURL: true,
          scale: 2, // native PDF DPI is often too low to read small dimension labels
          canvasImport: () => import("@napi-rs/canvas"),
        }),
      );
    }
    return images;
  }
  throw new Error(`Unsupported file type for drawing analysis: ${mimeType}`);
}

// pageNumber is model-reported here, unlike text documents' locateQuotePage
// text search -- there's no extracted text layer to verify it against, so
// this is a real (accepted) trust reduction versus the text-document path.
// estimateId inherits the document's own manual tag directly (a rendering
// package is always cleanly single-project, unlike a meeting transcript)
// -- no vision-based project classification here, just server-known
// truth carried through, same "resolve against known truth" discipline
// as document-summary-service.ts.
function withEmptyQuote<T extends { pageNumber: number }>(
  items: T[],
  estimateId: string | null,
): (T & { sourceQuote: string; estimateId: string | null })[] {
  return items.map((item) => ({ ...item, sourceQuote: "", estimateId }));
}

export async function summarizeDrawing(documentId: string, userId: string | null = null) {
  let loaded: { document: Awaited<ReturnType<typeof getDocumentBytes>>["document"]; bytes: Buffer };
  try {
    loaded = await getDocumentBytes(documentId);
  } catch {
    // Same retry posture as the OpenAI-call catch below -- see
    // document-summary-service.ts's identical guard for the full
    // rationale (a stale storage reference used to crash the whole
    // Server Action instead of landing here).
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
  const { document, bytes } = loaded;

  // Checked before any DB write, same posture as summarizeDocument -- a
  // missing key leaves the document PENDING/retryable, not stuck.
  const client = getOpenAiClient();

  await db.document.update({ where: { id: documentId }, data: { extractionStatus: "PROCESSING" } });

  try {
    const images = await pageImages(document.mimeType, bytes);
    if (images.length === 0) {
      // A genuinely empty PDF -- not an API/parse failure, a real
      // "nothing to analyze here" outcome that re-analyzing will never
      // change, so UNSUPPORTED (not the retryable FAILED) is correct.
      return db.document.update({ where: { id: documentId }, data: { extractionStatus: "UNSUPPORTED" } });
    }

    const completion = await client.chat.completions.create({
      model: ADVANCED_MODEL,
      // Low, not zero -- exhaustive extraction, not creative writing, so
      // there's no upside to the API default's high randomness. This was
      // the one AI call in the app that never got this pinned when the
      // other three (document-summary-service.ts, scope-coverage-
      // service.ts, clarification-questions-service.ts) did earlier --
      // confirmed the gap was real, not just theoretical, by a live
      // re-run against the exact same page images going from 9 real
      // extracted facts to 0.
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Drawing: ${document.filename} (${images.length} page image${images.length === 1 ? "" : "s"})`,
            },
            ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: DRAWING_SCHEMA },
    });

    await recordAiUsage({
      userId,
      feature: "DRAWING_SUMMARY",
      model: ADVANCED_MODEL,
      usage: completion.usage,
      documentId,
      opportunityId: document.opportunityId,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response.");
    const parsed = JSON.parse(content) as DrawingSummaryFromAI;

    const summary: DocumentSummary = {
      eventOrProjectName: parsed.eventOrProjectName,
      venue: parsed.venue,
      submissionDeadline: parsed.submissionDeadline,
      keyDates: withEmptyQuote(parsed.keyDates, document.estimateId),
      scopeSummary: withEmptyQuote(parsed.scopeSummary, document.estimateId),
      riskFlags: withEmptyQuote(parsed.riskFlags, document.estimateId),
    };

    return db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "COMPLETE", extractedSummary: summary as unknown as Prisma.InputJsonObject },
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unsupported file type")) throw err; // programmer/config error, not retryable by clicking Analyze
    // Corrupt/unparseable PDF, a vision call failure, a malformed
    // response -- same FAILED/retryable posture as summarizeDocument's
    // catch-all.
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
}
