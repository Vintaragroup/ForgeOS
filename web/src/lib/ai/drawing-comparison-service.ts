// What changed between a drawing and the drawing it replaces.
//
// This is the only comparison in the re-cost review that works on a
// rendering package, which is what a revised design usually arrives as.
// ABC Chicago's revised drawing extracted 33 scope items and not one
// dimension, because it is renderings: the model said so itself, *"no
// dimensions or specifications called out on these rendering pages"*.
// A schedule diff cannot name a reception counter. A rendering can.
//
// Deliberately NOT a diff of the two documents' extractedSummary lists.
// Each of those was written independently, answering "what is on this
// sheet", with neither aware the other exists -- so neither was ever
// asked to notice a change. Against Full Swing's hanging sign that
// yields "dimensioned tapered fabric volume" versus "signage, no
// dimensions", which reports that something differs and nothing about
// what. The difference that matters is in the pictures.
//
// See docs/recost-review.md.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { getDrawingAiClient, DRAWING_REQUEST_TIMEOUT_MS } from "@/lib/ai/drawing-ai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { UserError } from "@/lib/user-error";
import { comparisonPageImages } from "@/lib/ai/drawing-summary-service";
import {
  assessDrawingCharacter,
  characterMismatchGuidance,
  charactersDiffer,
  describeCharacter,
  type DrawingCharacter,
} from "@/lib/ai/drawing-character";

// The scope lines an extraction produced, which is what character is
// read from. Returns [] for a document that was never analysed, which
// assessDrawingCharacter reports as UNKNOWN rather than guessing.
function scopeTextsOf(extractedSummary: unknown): string[] {
  const s = extractedSummary as { scopeSummary?: { text?: unknown }[] } | null;
  if (!s || !Array.isArray(s.scopeSummary)) return [];
  return s.scopeSummary.map((i) => (typeof i?.text === "string" ? i.text : "")).filter(Boolean);
}

export { describeCharacter };

// The estimating rules (data/Estimate-Guidelines, Taze Ankerstein,
// 2026-09-21) forbid inferring cost from a picture, three separate
// times, and this call is the one most likely to break that. The
// prohibitions are stated as refusals rather than preferences because a
// rendering showing two screens is exactly the kind of thing a model
// will helpfully decide needs mounts, cabling and power.
export const SYSTEM_PROMPT = `You are comparing two revisions of an exhibit/booth design for an event contractor. You are shown every page of the PREVIOUS drawing, then every page of the REVISED drawing. Each page is labelled.

Report only what visibly differs between the two sets. Your job is to notice change, not to describe either drawing.

Report a difference when something is:
- present in the previous drawing and absent from the revised one (REMOVED)
- absent from the previous drawing and present in the revised one (ADDED)
- present in both but visibly different in form, size, count, or construction (CHANGED)

Name the subject the way an exhibit estimator would -- "reception counter", "hanging sign", "batting cage structure", "video wall" -- because these findings are matched against booths with names like that.

HARD RULES. These override any instinct to be helpful:
- Never infer a component that is not visibly shown. A rendering showing illumination does NOT mean LED strips, drivers, power supplies, dimmers or power strips exist. A rendering showing a screen does NOT mean a mount, bracket, cabling, power accessory or AV hardware exists.
- Never state a dimension, size, material, or specification unless it is printed on the sheet. If the revised sign is visibly shorter, say it is visibly shorter -- do not estimate by how much.
- Never infer freight, installation, engineering, repairs or refurbishment.
- If you cannot tell whether something changed, do not report it. A missing finding is recoverable; an invented one is not.
- Different camera angles between the two sets are not a change. Only report a difference in the thing itself.
- A different way of DRAWING something is not a change either. A dimensioned elevation and a photorealistic view of the same counter are the same counter. Report a difference only when the thing itself is genuinely absent from, or new to, the booth.

If nothing differs, return an empty array.`;

export const COMPARISON_SCHEMA = {
  name: "drawing_comparison",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["REMOVED", "ADDED", "CHANGED"] },
            subject: {
              type: "string",
              description:
                "What changed, named as an exhibit estimator would name it -- 'reception counter', 'hanging sign', 'video wall'. Not a sentence.",
            },
            detail: {
              type: "string",
              description:
                "What is visibly different, in one sentence, describing only what can be seen. No dimensions unless printed on the sheet.",
            },
            previousPage: {
              type: ["integer", "null"],
              description: "The PREVIOUS drawing page this is visible on, or null for an ADDED finding.",
            },
            revisedPage: {
              type: ["integer", "null"],
              description: "The REVISED drawing page this is visible on, or null for a REMOVED finding.",
            },
          },
          required: ["kind", "subject", "detail", "previousPage", "revisedPage"],
        },
      },
    },
    required: ["findings"],
  },
} as const;

export type DrawingChangeKind = "REMOVED" | "ADDED" | "CHANGED";

export interface DrawingChangeFinding {
  kind: DrawingChangeKind;
  subject: string;
  detail: string;
  previousPage: number | null;
  revisedPage: number | null;
}

export interface DrawingComparison {
  previousDocumentId: string;
  previousFilename: string;
  revisedDocumentId: string;
  revisedFilename: string;
  findings: DrawingChangeFinding[];
  // Recorded so a thin result can be read as "few pages were compared"
  // rather than "little changed".
  previousPagesCompared: number;
  revisedPagesCompared: number;
  charactersMismatched: boolean;
  previousCharacter: DrawingCharacter;
  revisedCharacter: DrawingCharacter;
  comparedAt: string;
}

// Compares a drawing against the one it supersedes, and stores the
// result on the revised document.
export async function compareDrawingToPredecessor(
  opportunityId: string,
  documentId: string,
  userId: string | null,
): Promise<DrawingComparison> {
  const revised = await db.document.findFirst({
    where: { id: documentId, opportunityId, deletedAt: null },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      documentType: true,
      extractedSummary: true,
      supersedes: {
        select: {
          id: true,
          filename: true,
          mimeType: true,
          documentType: true,
          deletedAt: true,
          extractedSummary: true,
        },
      },
    },
  });
  if (!revised) throw new UserError("That document isn't on this opportunity.");
  if (revised.documentType !== "DRAWING") {
    throw new UserError("Only a drawing can be compared against the drawing it replaces.");
  }
  const previous = revised.supersedes;
  if (!previous || previous.deletedAt) {
    throw new UserError("This drawing doesn't replace another one, so there's nothing to compare it against.");
  }
  if (previous.documentType !== "DRAWING") {
    throw new UserError(`${previous.filename} isn't a drawing, so these two can't be compared as designs.`);
  }

  const { bytes: previousBytes } = await getDocumentBytes(previous.id);
  const { bytes: revisedBytes } = await getDocumentBytes(revised.id);

  // Both sets in one request, at comparison resolution -- see
  // comparisonPageImages for why that is lower than analysis resolution
  // and why that is sound here.
  const [previousPages, revisedPages] = await Promise.all([
    comparisonPageImages(previous.mimeType, previousBytes),
    comparisonPageImages(revised.mimeType, revisedBytes),
  ]);

  if (previousPages.length === 0 || revisedPages.length === 0) {
    throw new UserError(
      "One of these drawings produced no readable pages, so there's nothing to compare. Re-analyze it first.",
    );
  }

  // Whether these two are the same KIND of drawing. A component sheet
  // compared against a rendering reports representation as change -- the
  // first real run of this called Full Swing's batting cage ADDED when
  // it is in both sets, because a dimension label on an elevation and a
  // photorealistic chain-link enclosure do not look alike.
  const previousCharacter = assessDrawingCharacter(scopeTextsOf(previous.extractedSummary));
  const revisedCharacter = assessDrawingCharacter(scopeTextsOf(revised.extractedSummary));
  const mismatched = charactersDiffer(previousCharacter.character, revisedCharacter.character);

  const { client, model, viaOpenRouter } = getDrawingAiClient();
  void viaOpenRouter;

  const content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] = [
    {
      type: "text",
      text:
        `PREVIOUS drawing: ${previous.filename} (${previousPages.length} pages). ` +
        `REVISED drawing: ${revised.filename} (${revisedPages.length} pages). ` +
        `The previous drawing's pages come first, then the revised drawing's.` +
        (mismatched
          ? `\n\n${characterMismatchGuidance(previousCharacter.character, revisedCharacter.character)}`
          : ""),
    },
  ];
  for (const page of previousPages) {
    content.push({ type: "text", text: `PREVIOUS drawing — page ${page.pageNumber}` });
    content.push({ type: "image_url", image_url: { url: page.dataUrl } });
  }
  for (const page of revisedPages) {
    content.push({ type: "text", text: `REVISED drawing — page ${page.pageNumber}` });
    content.push({ type: "image_url", image_url: { url: page.dataUrl } });
  }

  const completion = await client.chat.completions.create(
    {
      model,
      // Same reasoning as every other extraction call in this app:
      // exhaustive comparison, not creative writing.
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: { type: "json_schema", json_schema: COMPARISON_SCHEMA },
    },
    { timeout: DRAWING_REQUEST_TIMEOUT_MS },
  );

  await recordAiUsage({
    userId,
    feature: "DRAWING_SUMMARY",
    model,
    usage: completion.usage,
    documentId: revised.id,
    opportunityId,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new UserError("The comparison came back empty. Try again.");
  const parsed = JSON.parse(raw) as { findings: DrawingChangeFinding[] };

  // Page numbers are model-reported and are the one field it can get
  // wrong without being obviously wrong, so anything outside the real
  // range is dropped rather than shown as a citation that leads nowhere.
  const previousMax = Math.max(...previousPages.map((p) => p.pageNumber));
  const revisedMax = Math.max(...revisedPages.map((p) => p.pageNumber));
  const inRange = (n: number | null, max: number) => (n !== null && n >= 1 && n <= max ? n : null);

  const comparison: DrawingComparison = {
    previousDocumentId: previous.id,
    previousFilename: previous.filename,
    revisedDocumentId: revised.id,
    revisedFilename: revised.filename,
    findings: (parsed.findings ?? []).map((f) => ({
      kind: f.kind,
      subject: f.subject,
      detail: f.detail,
      previousPage: inRange(f.previousPage, previousMax),
      revisedPage: inRange(f.revisedPage, revisedMax),
    })),
    previousPagesCompared: previousPages.length,
    revisedPagesCompared: revisedPages.length,
    // Carried so the reader sees the caveat the prompt was given. A
    // finding from a mismatched pair is likelier to be representation
    // than change, and that is worth knowing at the point of reading it.
    charactersMismatched: mismatched,
    previousCharacter: previousCharacter.character,
    revisedCharacter: revisedCharacter.character,
    comparedAt: new Date().toISOString(),
  };

  await db.document.update({
    where: { id: revised.id },
    data: { revisionComparison: comparison as unknown as Prisma.InputJsonValue },
  });

  return comparison;
}
