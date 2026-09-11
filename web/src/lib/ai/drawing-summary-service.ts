// Companion to document-summary-service.ts for DRAWING documents -- a
// CAD-exported PDF or raw photographed/scanned drawing carries its content
// as vector geometry or a picture rather than a document meant to be read
// top-to-bottom, so the input pipeline and prompt here are genuinely
// different (page images, vision content parts) rather than a variant of
// the text summarizer. That does NOT mean no extractable text exists,
// though -- confirmed live (FootJoy 2027 design takeoff, Sept 2026) that a
// real CAD export can carry a full, accurate embedded text layer for every
// dimension/material label despite looking purely visual. pageImages below
// now returns that text alongside each image (ground truth when present,
// vision-only fallback when a page genuinely has none -- an AutoCAD
// SHX-annotation table or a scanned page), rather than assuming a drawing
// never has one. Reuses document-summary-service.ts's DocumentSummary/
// CitedText/KeyDateFact/KeyDateType shapes one-directionally, so
// ProjectBriefCard (opportunities/[id]/page.tsx) needs zero changes to
// render either kind.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import {
  getDrawingAiClient,
  DRAWING_REASONING_BUDGET,
  DRAWING_REQUEST_TIMEOUT_MS,
  buildPageContentParts,
} from "@/lib/ai/drawing-ai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import type { DocumentSummary, KeyDateType } from "@/lib/ai/document-summary-service";
import { PDF_MIME, extractPdfPageTexts } from "@/lib/ai/text-extraction";
import { ensureCanvasFontsRegistered } from "@/lib/canvas-fonts";
import { isBlankPageImage } from "@/lib/ai/blank-page-detection";

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg"];

// Bounds cost, not accuracy -- raised from 5 to 10 after a real 11-page CAD
// PDF only had its first 5 pages analyzed and missed real, later-page facts,
// then raised again to 20 after a SECOND real 11-page CAD design takeoff
// (FootJoy PGA 2027) silently tripped the 10-page cap too -- two for two on
// real takeoff packages landing at 11 pages says the realistic ceiling for
// this document type is meaningfully above 10, not a one-off. Cost stays
// trivial even doubled (~$0.05-0.06 at 20 images), worth it against missing
// a whole sheet's content with zero indication anything was dropped.
// Configurable so a package that genuinely needs more sheets analyzed isn't
// hard-blocked, and pageImages now reports totalPages so a caller can at
// least detect when this cap is still hit.
const MAX_DRAWING_PAGES = Number(process.env.AI_DRAWING_MAX_PAGES) || 20;

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
              description:
                "The page number given in that page's 'Page N' label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).",
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
            pageNumber: {
              type: "integer",
              description:
                "The page number given in that page's 'Page N' label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).",
            },
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
            pageNumber: {
              type: "integer",
              description:
                "The page number given in that page's 'Page N' label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).",
            },
          },
          required: ["text", "pageNumber"],
        },
      },
    },
    required: ["eventOrProjectName", "venue", "submissionDeadline", "keyDates", "scopeSummary", "riskFlags"],
  },
} as const;

// Exported for direct testing, same precedent as drawing-line-item-service.ts's
// own SYSTEM_PROMPT export.
export const SYSTEM_PROMPT = `You are looking at pages of a fabrication/construction drawing or CAD export for an event/exhibit contractor. Extract only what's visibly labeled or dimensioned on the sheets -- never infer a dimension, material, or date that isn't actually printed or drawn. If nothing relevant is present, use null or an empty array.

Each page is given to you twice: first as its real extracted PDF text (when the export tool embedded one -- exact labels, dimensions, and callouts, character-for-character as printed), then as a rendered image of that same page. When real text is present for a page, treat it as the authoritative source for exact wording and numbers -- it can't be misread the way a visual scan can. Use the image to see how those labels relate to what they're pointing at, and to catch anything the text didn't capture. A page whose text line says none was extracted has no text layer at all (an AutoCAD SHX-annotation table, or a scanned page) -- read the image alone for that one.

When reading dimensions directly off an image (no text layer for that page), read the actual punctuation printed rather than assuming a format: exhibit/booth CAD exports commonly use decimal-inch notation exclusively -- e.g. 39.06" means thirty-nine and six-hundredths of an INCH (a decimal point before the last two digits, not a feet mark) -- not the X'-Y" feet-and-inches format common in other construction drawings. Don't convert or reinterpret a decimal-inch number into feet-and-inches; copy the digits and punctuation exactly as they appear.

scopeSummary: specific, sheet-grounded facts a bidder needs to price the work -- dimensions, materials called out, construction/assembly methods, finish notes. Not a generic description of "a booth drawing."
riskFlags: anything a reviewer should double-check before bidding -- structural/load callouts, code/compliance notes, ADA clearances, an engineer's stamp, or a revision marked "hold"/"not for construction."
keyDates: almost always empty -- only populate if an actual date is printed on the sheet (e.g. a title-block revision date or issue date). Never invent a submission deadline from a drawing; that belongs to the RFP text, not this document.

Extract every distinct dimension, material, price, and callout you can find on each sheet, not just the most prominent ones -- a second look at the same sheet should find just as much as the first. Err toward including a borderline item rather than omitting it.

For every item, report pageNumber: the page number given in that page's "Page N" label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).`;

// Exported for direct testing of the mime-branching logic -- this part
// needs only unpdf, not OpenAI, so it can run for real in CI (see
// drawing-summary-service.test.ts).
// totalPages lets a caller tell truncation apart from "this document
// genuinely only has N pages" -- images.length alone can't distinguish
// those, which is exactly how the cap silently ate a real sheet's content
// twice before either instance was noticed. maxPages defaults to the
// module cap but is an explicit parameter so a test can force a small cap
// deterministically instead of stubbing the env var + resetting the module.
// pageTexts is parallel-indexed to images: each entry is that page's real
// extracted PDF text (see this file's header comment), or "" when the page
// has none -- reuses text-extraction.ts's extractPdfPageTexts rather than
// a second unpdf call, same real text every other document type already
// trusts.
// pageNumbers is ALSO parallel-indexed to images: the true 1-indexed
// source-PDF page number for each entry. Required (not inferred from
// array position) because blankPageNumbers below can exclude a page
// mid-sequence -- images[i] is no longer implicitly page i+1 once that
// can happen, and citing "page 3" from array position when the real page
// was 4 would be a real correctness regression against the AI's own page
// citations. blankPageNumbers is the 1-indexed list of pages that
// rendered blank (see isBlankPageImage's own header for the real incident
// this addresses) and were excluded from images/pageTexts/pageNumbers
// entirely -- a caller derives "how many pages were attempted" as
// images.length + blankPageNumbers.length rather than a separate field.
export async function pageImages(
  mimeType: string,
  bytes: Buffer,
  maxPages: number = MAX_DRAWING_PAGES,
): Promise<{ images: string[]; totalPages: number; pageTexts: string[]; pageNumbers: number[]; blankPageNumbers: number[] }> {
  if (IMAGE_MIMES.includes(mimeType)) {
    // A raw image (not a PDF) has no text layer at all -- "" here is the
    // same "vision only for this page" signal the PDF branch uses when
    // extraction comes back empty, not a special case callers need to
    // branch on separately. Checked for blankness too -- a directly-
    // uploaded scan can legitimately be blank the same way a rendered PDF
    // page can.
    const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
    if (await isBlankPageImage(dataUrl)) {
      return { images: [], totalPages: 1, pageTexts: [], pageNumbers: [], blankPageNumbers: [1] };
    }
    return { images: [dataUrl], totalPages: 1, pageTexts: [""], pageNumbers: [1], blankPageNumbers: [] };
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
    const pageCount = Math.min(pdf.numPages, maxPages);

    // Extracted BEFORE rasterization now (was after) specifically so each
    // page's own text density can inform that page's rasterization scale
    // below -- see TEXT_RICH_CHAR_THRESHOLD. Best-effort: a text-extraction
    // failure (corrupt/unusual PDF structure) shouldn't take down the whole
    // vision analysis -- every page just falls back to "" (image-only,
    // full-scale), same as a page that genuinely has no text layer at all.
    let allPageTexts: string[];
    try {
      allPageTexts = (await extractPdfPageTexts(bytes)).slice(0, pageCount).map((t) => t.trim());
    } catch {
      allPageTexts = [];
    }
    while (allPageTexts.length < pageCount) allPageTexts.push("");

    // Real incident (Titleist FootJoy re-upload, Sept 2026): a rasterization
    // run on a large (18.7MB, 11-page, embedded-font-subset) PDF died with a
    // bare 500 after ~12s and zero catchable exception -- no page number, no
    // stack trace, nothing this function's own error handling ever got a
    // chance to log. Root-caused by locally re-running this exact function
    // with memory logging added: rendering all 11 pages peaked at 4.09GB RSS
    // (process.memoryUsage().rss -- total process memory, including
    // @napi-rs/canvas's native/off-heap allocations, unlike
    // --max-old-space-size which only caps the JS heap) for a task whose
    // real output is 6.3MB of base64 image data -- almost certainly what
    // exceeds Vercel's function memory ceiling and gets the process killed
    // outright, with no JS exception to catch. First suspected the
    // rasterization `scale` (canvas buffer size), but a live re-test at a
    // lower scale for text-rich pages barely moved the peak (still ~4.1GB) --
    // ruling that out. The real cause: PDF.js's PDFDocumentProxy caches each
    // page's decoded resources (fonts, decompressed images/content streams)
    // internally and never evicts them on its own -- calling pdf.getPage()
    // repeatedly on the SAME shared proxy (as this loop does, on purpose, to
    // avoid re-parsing the whole file per page) accumulates every page's
    // retained resources for the life of that proxy. pdf.cleanup() (a real,
    // documented PDFDocumentProxy method -- confirmed present at runtime)
    // explicitly clears those caches; safe to call between renders (not
    // during one), which a completed loop iteration always is.
    //
    // Real incident (Titleist "Concept V1E" upload, Sept 2026): a 31-page
    // drawing rendered every single page blank -- the source PDF's
    // embedded images are all JPEG2000 (jpx) encoded, and @napi-rs/
    // canvas's bundled PDF.js can't decode that format (logs "JpxError:
    // OpenJPEG failed to initialize" and silently produces a blank canvas
    // instead of throwing). isBlankPageImage catches this before a blank
    // page can be sent to the vision AI -- see its own header for the
    // full root-cause writeup and why pixel-uniformity (not byte-size
    // alone) is the reliable signal.
    const images: string[] = [];
    const pageTexts: string[] = [];
    const pageNumbers: number[] = [];
    const blankPageNumbers: number[] = [];
    for (let page = 1; page <= pageCount; page++) {
      const dataUrl = await renderPageAsImage(pdf, page, {
        toDataURL: true,
        scale: 2, // native PDF DPI is often too low to read small dimension labels
        canvasImport: () => import("@napi-rs/canvas"),
      });
      await pdf.cleanup();
      if (await isBlankPageImage(dataUrl)) {
        blankPageNumbers.push(page);
        console.warn(
          `[pageImages] page ${page}/${pageCount} rendered blank (likely an undecodable embedded image, e.g. JPEG2000) -- excluded from vision analysis`,
        );
      } else {
        images.push(dataUrl);
        pageTexts.push(allPageTexts[page - 1]);
        pageNumbers.push(page);
      }
      console.log(
        `[pageImages] rendered page ${page}/${pageCount}, rss=${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`,
      );
    }
    return { images, totalPages: pdf.numPages, pageTexts, pageNumbers, blankPageNumbers };
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
  // missing key leaves the document PENDING/retryable, not stuck. See
  // drawing-ai-client.ts's own header for why this can be OpenRouter
  // instead of OpenAI direct -- scoped to this pipeline only.
  const { client, model, viaOpenRouter } = getDrawingAiClient();

  await db.document.update({ where: { id: documentId }, data: { extractionStatus: "PROCESSING" } });

  try {
    const { images, totalPages, pageTexts, pageNumbers, blankPageNumbers } = await pageImages(document.mimeType, bytes);
    if (images.length === 0) {
      // A genuinely empty PDF, OR every rendered page came back blank
      // (see isBlankPageImage's header for the real JPEG2000-decode
      // incident this catches) -- either way, not an API/parse failure,
      // a real "nothing to analyze here" outcome that re-analyzing won't
      // change on its own, so UNSUPPORTED (not the retryable FAILED) is
      // correct. Reused analysisError/analysisErrorAt here (previously
      // FAILED-only) rather than a new field -- same nullable-reason-
      // plus-timestamp shape, already cleared on the next successful
      // analysis below, no migration needed. A blank-render reason is
      // specific and actionable; a genuinely empty PDF gets a generic one.
      const reason =
        blankPageNumbers.length > 0
          ? `All ${blankPageNumbers.length} rendered page${blankPageNumbers.length === 1 ? "" : "s"} came back blank -- likely an embedded image encoding (e.g. JPEG2000) this system can't decode. Re-export this drawing as a standard PDF/JPEG/PNG, or contact support.`
          : "This PDF has no pages to render.";
      return db.document.update({
        where: { id: documentId },
        data: { extractionStatus: "UNSUPPORTED", analysisError: reason, analysisErrorAt: new Date() },
      });
    }

    const completion = await client.chat.completions.create({
      model,
      // Low, not zero -- exhaustive extraction, not creative writing, so
      // there's no upside to the API default's high randomness. This was
      // the one AI call in the app that never got this pinned when the
      // other three (document-summary-service.ts, scope-coverage-
      // service.ts, clarification-questions-service.ts) did earlier --
      // confirmed the gap was real, not just theoretical, by a live
      // re-run against the exact same page images going from 9 real
      // extracted facts to 0.
      temperature: 0.2,
      // See drawing-ai-client.ts's own comment -- only relevant for an
      // OpenRouter-routed reasoning model, inert otherwise.
      ...(viaOpenRouter ? (DRAWING_REASONING_BUDGET as unknown as Record<string, unknown>) : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Drawing: ${document.filename} (${images.length} page image${images.length === 1 ? "" : "s"})`,
            },
            ...buildPageContentParts(images, pageTexts, pageNumbers),
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: DRAWING_SCHEMA },
    }, { timeout: DRAWING_REQUEST_TIMEOUT_MS });

    await recordAiUsage({
      userId,
      feature: "DRAWING_SUMMARY",
      model,
      usage: completion.usage,
      documentId,
      opportunityId: document.opportunityId,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      // A reasoning model can burn its whole token budget on internal
      // reasoning and never reach the actual JSON -- a real failure mode
      // confirmed live via OpenRouter (see DRAWING_REASONING_BUDGET), not
      // hypothetical. Distinct message so this doesn't read as a plain API
      // hiccup when it's actually a budget-tuning problem.
      throw new Error(
        viaOpenRouter
          ? `${model} returned an empty response (possibly exhausted its reasoning token budget) -- see DRAWING_REASONING_BUDGET in drawing-ai-client.ts.`
          : "OpenAI returned an empty response.",
      );
    }
    const parsed = JSON.parse(content) as DrawingSummaryFromAI;

    const riskFlags = withEmptyQuote(parsed.riskFlags, document.estimateId);
    // Surfaced through the same riskFlags list ProjectBriefCard already
    // renders -- no schema/UI change needed to make a real truncation
    // visible to whoever's reviewing this document, instead of the silent
    // drop this cap used to produce. attempted (not images.length) is the
    // right comparand against totalPages now that blank pages are
    // excluded from images -- images.length alone would misfire this
    // truncation notice whenever ANY page is blank-excluded, even when
    // the page cap was never actually hit.
    const attempted = images.length + blankPageNumbers.length;
    if (totalPages > attempted) {
      riskFlags.push({
        text: `Only pages 1-${attempted} of ${totalPages} were analyzed (AI_DRAWING_MAX_PAGES limit) -- review the remaining pages manually or re-run with a higher limit.`,
        pageNumber: attempted,
        sourceQuote: "",
        estimateId: document.estimateId,
      });
    }
    // A partial failure (some pages blank, some real) shouldn't be a hard
    // FAILED/UNSUPPORTED outcome -- the good pages still got analyzed --
    // but it's real, actionable information a reviewer needs, so it goes
    // through the same reused riskFlags surface as the truncation notice
    // above rather than silently proceeding as if nothing was missed.
    if (blankPageNumbers.length > 0) {
      riskFlags.push({
        text: `Page${blankPageNumbers.length === 1 ? "" : "s"} ${blankPageNumbers.join(", ")} could not be rendered (the page's embedded image uses an encoding this system can't decode, e.g. JPEG2000) and ${blankPageNumbers.length === 1 ? "was" : "were"} excluded from analysis -- review ${blankPageNumbers.length === 1 ? "it" : "them"} manually.`,
        pageNumber: blankPageNumbers[0],
        sourceQuote: "",
        estimateId: document.estimateId,
      });
    }

    const summary: DocumentSummary = {
      eventOrProjectName: parsed.eventOrProjectName,
      venue: parsed.venue,
      submissionDeadline: parsed.submissionDeadline,
      keyDates: withEmptyQuote(parsed.keyDates, document.estimateId),
      scopeSummary: withEmptyQuote(parsed.scopeSummary, document.estimateId),
      riskFlags,
    };

    return db.document.update({
      where: { id: documentId },
      data: {
        extractionStatus: "COMPLETE",
        extractedSummary: summary as unknown as Prisma.InputJsonObject,
        analysisError: null,
        analysisErrorAt: null,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unsupported file type")) throw err; // programmer/config error, not retryable by clicking Analyze
    // Corrupt/unparseable PDF, a vision call failure, a malformed
    // response -- same FAILED/retryable posture as summarizeDocument's
    // catch-all. Logged AND persisted to analysisError -- a real
    // production incident (Sept 2026, Titleist PGA Orlando) left this
    // completely untraceable, since the write here used to discard the
    // real error before it could reach Vercel's own error tracking.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[summarizeDrawing] document ${documentId}: ${message}`);
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED", analysisError: message, analysisErrorAt: new Date() } });
  }
}
