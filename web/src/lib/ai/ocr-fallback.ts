// Real OCR fallback for a document that has no extractable text layer --
// see text-extraction.ts's own header comment for the gap this closes:
// every non-DRAWING document type (RFP, SCOPE_OF_WORK, CONTRACT, SCHEDULE,
// VENDOR_QUOTE, OTHER, MEETING_NOTES) previously went straight to
// UNSUPPORTED the moment extractDocumentText found no real text, with no
// fallback at all -- a scanned document's content was silently never
// extracted. Kept fully separate from drawing-summary-service.ts's own
// pageImages -- that pipeline has different needs (per-page text-layer
// merge, MAX_DRAWING_PAGES/CAD-specific scale tuning) this fallback
// doesn't share; this one is "render a page, OCR it, concatenate."
//
// Library choice: tesseract-wasm, not tesseract.js -- confirmed via a real
// deployed Vercel proof-of-concept (Sept 2026) that tesseract.js has an
// active, unresolved Vercel production bug (its own WASM file not found
// in the serverless bundle), while tesseract-wasm's Node entry point
// (`tesseract-wasm/node`, a real worker_threads.Worker spawning its own
// module file + a relative-path readFile for the wasm binary) was
// verified end-to-end on an actual Vercel deployment: model load, image
// load, and text recognition all completed with zero errors.
//
// This is a genuine, deliberate use of true OCR -- the only one in this
// codebase (confirmed via exhaustive grep: no other OCR engine exists
// anywhere) -- reserved specifically for "recover printed text from a
// scan," reached only after real embedded-text extraction has already
// failed, never used as a substitute for the drawing pipeline's vision-LLM
// reasoning.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import { createCanvas, loadImage } from "@napi-rs/canvas";
// @ts-expect-error -- tesseract-wasm ships no type declarations for this Node-specific subpath export
import { createOCRClient } from "tesseract-wasm/node";
import { isBlankPageImage } from "@/lib/ai/blank-page-detection";
import { ensureCanvasFontsRegistered } from "@/lib/canvas-fonts";

// Not imported from text-extraction.ts (which imports ocrDocumentText from
// this file) to avoid a circular module dependency -- both are stable,
// unchanging string constants, not worth a cycle to share.
const PDF_MIME = "application/pdf";
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg"]);

// OCR's real per-page latency (worker-side layout analysis + recognition,
// on top of the rasterization cost every page already pays) stacks inside
// the SAME single request/function-timeout budget as everything else
// extractDocumentText's caller (summarizeDocument) needs to do -- kept
// deliberately smaller than drawing-summary-service.ts's own
// MAX_DRAWING_PAGES (20), since a document that reaches this fallback at
// all is, by definition, already the degraded/best-effort path, not the
// primary one. Configurable for the same reason that one is.
const MAX_OCR_PAGES = Number(process.env.AI_OCR_MAX_PAGES) || 10;

let trainedDataPromise: Promise<Buffer> | null = null;

// Loaded once per process (Fluid Compute reuses the same Node process
// across invocations -- same "do it once at import/first-use time"
// posture as canvas-fonts.ts's own module-level font registration) and
// bundled directly in this repo rather than fetched from GitHub at
// request time -- avoids a new external-network dependency/failure mode
// on every cold start, same reasoning canvas-fonts.ts's own header gives
// for bundling DejaVu Sans instead of relying on a package-internal path.
function loadTrainedData(): Promise<Buffer> {
  if (!trainedDataPromise) {
    trainedDataPromise = readFile(path.join(process.cwd(), "src/assets/ocr/eng.traineddata"));
  }
  return trainedDataPromise;
}

async function ocrImage(client: InstanceType<typeof createOCRClient>, bytes: Buffer): Promise<string> {
  const img = await loadImage(bytes);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  await client.loadImage({ data, width: img.width, height: img.height });
  const text = await client.getText();
  await client.clearImage();
  return text;
}

// Any internal failure here (a corrupt/unusual PDF, an OCR engine error,
// an asset-load failure) turns into an empty-string result, never a
// thrown exception -- this is a best-effort enhancement layered onto an
// already-correct "give up gracefully" system (extractDocumentText's own
// UNSUPPORTED fallback), not a new way for extraction to hard-fail.
export async function ocrDocumentText(mimeType: string, bytes: Buffer): Promise<string> {
  try {
    let pageImageBytesList: Buffer[];

    if (mimeType === PDF_MIME) {
      ensureCanvasFontsRegistered();
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const pageCount = Math.min(pdf.numPages, MAX_OCR_PAGES);
      pageImageBytesList = [];
      for (let page = 1; page <= pageCount; page++) {
        const dataUrl = await renderPageAsImage(pdf, page, {
          toDataURL: true,
          scale: 2,
          canvasImport: () => import("@napi-rs/canvas"),
        });
        await pdf.cleanup();
        // Same real incident this check was built for (see
        // blank-page-detection.ts's header) -- no point spending OCR
        // compute on a page that failed to render at all.
        if (await isBlankPageImage(dataUrl)) continue;
        pageImageBytesList.push(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
      }
    } else if (IMAGE_MIMES.has(mimeType)) {
      // A scanned page uploaded directly as an image (not wrapped in a
      // PDF) -- no rasterization needed, OCR the bytes as-is. Previously
      // had zero handling anywhere in text-extraction.ts.
      pageImageBytesList = [bytes];
    } else {
      return "";
    }

    if (pageImageBytesList.length === 0) return "";

    const model = await loadTrainedData();
    const client = createOCRClient();
    try {
      await client.loadModel(model);
      const pageTexts: string[] = [];
      for (const pageBytes of pageImageBytesList) {
        pageTexts.push(await ocrImage(client, pageBytes));
      }
      return pageTexts.join("\n\n");
    } finally {
      client.destroy();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ocrDocumentText] OCR fallback failed, degrading to no text: ${message}`);
    return "";
  }
}
