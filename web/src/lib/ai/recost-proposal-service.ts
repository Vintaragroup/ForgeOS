// Maps a re-cost finding onto the line items it is actually about.
//
// Step 5 of docs/recost-review.md, and the only AI in the whole feature.
// Everything before it is deterministic and stays that way: the
// estimator's own status column, the drawing comparison, the arithmetic
// against the client's number. Those produce findings in the source's
// vocabulary -- "the front structure with monitors and LED elements is
// no longer present" -- and an estimate holds 225 rows in ForgeOS's
// vocabulary. Joining the two is a language problem, which is what a
// model is for, and it is all this stage does.
//
// What it deliberately does not do:
//
//   invent a price. A number survives only if it appears in the quote.
//   decide anything. Everything lands as PROPOSED for a human.
//   speak about line items outside the finding's scope. The candidate
//   list it is shown is already narrowed by provenance and booth.
//
// Everything it returns goes through validateProposals before it is
// written, and what is dropped is logged rather than silently discarded
// -- the last silent-drop bug in this codebase took a direct database
// read to find.

import { db } from "@/lib/db";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { UserError } from "@/lib/user-error";
import { buildRecostReview } from "@/lib/recost-review-service";
import {
  validateProposals,
  type ProposalFinding,
  type RawProposal,
  type RecostMode,
} from "@/lib/recost-proposal";
import type { Prisma } from "@/generated/prisma/client";

// ADVANCED_MODEL is not a default here, it is a requirement. This call
// reads across several named documents at once and has to keep straight
// which finding came from which -- exactly the shape where the basic
// model has already been caught misattributing content between named
// sources on this codebase.
const SYSTEM_PROMPT = `You map findings about a revised exhibit design onto the line items of an estimate.

A client has asked for a lower number. Other systems have already established WHAT changed, from the
estimator's own re-costed schedule and from a comparison of the revised drawing against the previous one.
Your only job is to say WHICH ROWS OF THE ESTIMATE each finding is about, and what kind of change it is.

HARD RULES. A proposal breaking any of these is discarded before anyone sees it:

1. sourceQuote must be copied VERBATIM from the finding's own text. Do not summarise it, do not merge two
   sentences, do not write what the finding implies. If you cannot quote it, do not propose it.
2. Only use lineItemId and sectionId values from the CANDIDATES list given for that finding. Never invent an
   id, never reuse an id from another finding's list.
3. Never state a price or quantity that is not written in the quote you cited. If the finding says something
   changed but nobody has priced it, the action is NEEDS_QUOTE and newUnitCost is null. This is the normal
   case and is a useful answer.
4. Do not infer dimensions, materials or specifications the source does not state.

ACTIONS:
  REMOVE      the scope is genuinely gone
  REDUCE_QTY  less of the same thing
  REPRICE     same scope, new number, and the number is in the quote
  RE_SOURCE   same scope, different vendor or cost basis (a rented AV package becoming purchased monitors)
  NEEDS_QUOTE it changed and nobody has priced it yet
  ADD         new scope that is not in the estimate

CONFIDENCE:
  RECOMMEND_AND_CONFIRM  the source says plainly what happened and to what
  NEED_YOUR_DECISION     the source shows a change but not what to do about it, or the match is uncertain

Prefer sectionId when a finding is about a whole booth or element -- an estimator thinks about "the reception
counter" as one thing, not as 25 separate removals. Use lineItemIds when the finding names something precise.

Return at most one proposal per finding. Omitting a finding is a legitimate answer when nothing in the
candidate list is plausibly what it is about; a wrong match is far worse than no match.`;

const PROPOSAL_SCHEMA = {
  name: "recost_proposals",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "findingId",
            "action",
            "lineItemIds",
            "sectionId",
            "reason",
            "sourceQuote",
            "sourceLocation",
            "confidence",
            "newUnitCost",
            "newQty",
          ],
          properties: {
            findingId: { type: "string" },
            action: { type: "string", enum: ["REMOVE", "REDUCE_QTY", "REPRICE", "RE_SOURCE", "NEEDS_QUOTE", "ADD"] },
            lineItemIds: { type: "array", items: { type: "string" } },
            sectionId: { type: ["string", "null"] },
            reason: { type: "string" },
            sourceQuote: { type: "string" },
            sourceLocation: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["RECOMMEND_AND_CONFIRM", "NEED_YOUR_DECISION"] },
            newUnitCost: { type: ["number", "null"] },
            newQty: { type: ["number", "null"] },
          },
        },
      },
    },
  },
} as const;

export interface RecostProposalRun {
  proposed: number;
  rejected: { findingId: string; why: string }[];
  uncovered: string[];
}

export async function proposeRecostChanges(
  estimateId: string,
  userId: string,
  mode: RecostMode = "VALUE_ENGINEERING",
): Promise<RecostProposalRun> {
  const review = await buildRecostReview(estimateId);
  if (!review) throw new UserError("This estimate has no open version to re-cost.");

  const estimate = await db.estimate.findFirstOrThrow({
    where: { id: estimateId, deletedAt: null },
    select: { opportunityId: true },
  });

  // Findings the drawing raised that nothing has priced. The ones the
  // schedule already settled are not sent: an estimator wrote the answer
  // down and there is nothing for a model to add.
  const open = (review.drawing?.findings ?? []).filter((f) => f.kind !== "CORROBORATED");
  if (open.length === 0) {
    return { proposed: 0, rejected: [], uncovered: [] };
  }

  const drawingDocument = await db.document.findFirst({
    where: { opportunityId: estimate.opportunityId, filename: review.drawing!.revisedFilename, deletedAt: null },
    select: { id: true },
  });
  if (!drawingDocument) throw new UserError("The compared drawing is no longer on this opportunity.");

  const allSections = await db.estimateSection.findMany({
    where: { estimateVersionId: review.estimateVersionId },
    select: {
      id: true,
      name: true,
      groupLabel: true,
      lineItems: { select: { id: true, description: true, totalCost: true }, orderBy: { totalCost: "desc" } },
    },
  });

  // A section with no line items in it cannot be the subject of
  // anything. ABC Chicago carries four of them -- "Booth Structure &
  // Walls", "Doors & Hardware" and friends are catalog categories that
  // were created and never filled -- and offered as candidates they are
  // exactly what a model reaches for: the first run put both structure
  // removals against "Booth Structure & Walls", $0 across 0 rows, which
  // is a proposal to remove nothing. Not the model's mistake. It was
  // shown a plausible name and had no way to know it was empty.
  const sections = allSections.filter((s) => s.lineItems.length > 0);
  if (sections.length === 0) {
    throw new UserError("This version has no priced line items to map findings onto yet.");
  }

  // Numbered, because a model asked to work through a list needs the
  // list to have handles. Ids are opaque cuids and stay that way -- an
  // id it cannot guess is an id it cannot invent.
  const findings: ProposalFinding[] = open.map((f, i) => ({
    id: `F${i + 1}`,
    sourceDocumentId: drawingDocument.id,
    // Both halves are citable: the model may quote the subject or the
    // detail, and refusing the subject would reject honest citations.
    sourceText: `${f.subject}. ${f.detail}`,
  }));

  const findingBlock = open
    .map((f, i) => `F${i + 1} [${f.kind}] ${f.subject} — ${f.detail}${f.pages ? ` (${f.pages})` : ""}`)
    .join("\n");

  const candidateBlock = sections
    .map((s) => {
      const label = s.groupLabel ? `${s.groupLabel} / ${s.name}` : s.name;
      const items = s.lineItems
        .slice(0, 12)
        .map((li) => `    lineItemId=${li.id} $${li.totalCost.toFixed(0)} ${li.description}`)
        .join("\n");
      return `  sectionId=${s.id} "${label}"\n${items}`;
    })
    .join("\n");

  const client = getOpenAiClient();
  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    // Low for the same reason the clarification-questions call is low:
    // this is structured judgement, not writing, and sampling noise here
    // shows up as a different set of proposals on an unchanged estimate.
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `MODE: ${mode}\n\n` +
          `FINDINGS — consider every one of these by id:\n\n${findingBlock}\n\n` +
          `CANDIDATES — the only ids you may name:\n\n${candidateBlock}`,
      },
    ],
    response_format: { type: "json_schema", json_schema: PROPOSAL_SCHEMA },
  });

  await recordAiUsage({
    userId,
    feature: "RECOST_PROPOSALS",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    opportunityId: estimate.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new UserError("The proposal run came back empty. Try again.");
  const parsed = JSON.parse(content) as { proposals: RawProposal[] };

  const result = validateProposals(parsed.proposals ?? [], {
    mode,
    findings,
    lineItemIds: new Set(sections.flatMap((s) => s.lineItems.map((li) => li.id))),
    sectionIds: new Set(sections.map((s) => s.id)),
  });

  // Said out loud. A run where most proposals fail validation is a
  // prompt problem, and it is invisible if only the survivors are
  // written.
  if (result.rejected.length > 0) {
    console.warn(
      `[recost] ${result.rejected.length} of ${parsed.proposals?.length ?? 0} proposals rejected:`,
      result.rejected,
    );
  }

  // Replaced rather than appended: a re-run is a re-read of the same
  // documents, and two runs' worth of proposals side by side is a list
  // nobody can act on. Decided rows survive -- a human's answer is not
  // a model's to overwrite.
  await db.$transaction(async (tx) => {
    await tx.recostProposal.deleteMany({
      where: { estimateVersionId: review.estimateVersionId, status: "PROPOSED" },
    });
    if (result.proposals.length === 0) return;

    const rows: Prisma.RecostProposalCreateManyInput[] = [];
    for (const p of result.proposals) {
      const base = {
        estimateVersionId: review.estimateVersionId,
        action: p.action,
        reason: p.reason,
        sourceDocumentId: p.sourceDocumentId,
        sourceQuote: p.sourceQuote,
        sourceLocation: p.sourceLocation,
        confidence: p.confidence,
        newUnitCost: p.newUnitCost,
        newQty: p.newQty,
      };
      // One row per line item, because that is how they are decided and
      // applied. A section proposal is a single row.
      if (p.lineItemIds.length > 0) {
        for (const lineItemId of p.lineItemIds) rows.push({ ...base, lineItemId });
      } else {
        rows.push({ ...base, sectionId: p.sectionId });
      }
    }

    await tx.recostProposal.createMany({ data: rows });
  });

  return { proposed: result.proposals.length, rejected: result.rejected, uncovered: result.uncovered };
}
