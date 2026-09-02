// Phase 7.3 (chat roadmap Phase 1-2): assembles the system prompt for
// Opportunity chat. Chat roadmap Phase 3 replaced document handling with
// real retrieval (document-embedding-service.ts): an indexed document
// contributes only the chunks retrieveRelevantChunks finds relevant to
// THIS question, not its full text -- the priority-ordered, budget-gated
// full-text dump below now only ever runs for a document that has no
// chunks yet (not indexed since upload/last edit, or indexing failed;
// see getIndexedDocumentIds), so nothing regresses for a not-yet-indexed
// corpus while a fully-indexed one scales past the old fixed-budget
// ceiling entirely.

import { db } from "@/lib/db";
import type { DocumentType } from "@/generated/prisma/enums";
import { truncateForCitation } from "@/lib/citation";
import { getIndexedDocumentIds, retrieveRelevantChunks, type RetrievedChunk } from "@/lib/ai/document-embedding-service";

// Long enough to be a genuinely identifiable excerpt, short enough that a
// hundred sourced line items don't quietly crowd out the rest of the
// context budget -- see truncateForCitation's own comment for why the
// exact same truncated text also has to be what getCitableQuotes
// (chat-service.ts) later searches a reply for. Exported so that file
// truncates with this identical value rather than a second literal that
// could quietly drift from this one.
export const MAX_QUOTE_CONTEXT_CHARS = 140;

// PRICING_SCHEDULE is deliberately absent -- its raw cell text is a worse
// signal than the imported LineItems already summarized below (see
// pricing-import-service.ts). DRAWING is absent too -- never has
// extractedText (see text-extraction.ts), nothing to include.
const DOCUMENT_PRIORITY: DocumentType[] = ["RFP", "SCOPE_OF_WORK", "CONTRACT", "SCHEDULE", "OTHER"];

const MAX_CONTEXT_CHARS = 150_000;
const MAX_HISTORY_MESSAGES = 20;

export interface ChatContext {
  systemPrompt: string;
  documentsIncluded: string[];
  documentsDropped: string[];
  // Line items left out of the prompt entirely because the budget ran out
  // before they were reached (confirmed items always go in before drafts,
  // see buildEstimateBlock) -- surfaced by chat-service.ts alongside
  // documentsDropped so the widget can tell the user the answer may be
  // incomplete instead of silently guessing from a partial estimate.
  lineItemsOmitted: number;
}

// Rendered through react-markdown in a ~24rem chat bubble (ChatWidget),
// not a full page -- short paragraphs and light formatting read as a
// conversation there; a big heading or a deeply nested list reads as a
// document that wandered into the wrong window.
const SYSTEM_PREAMBLE = `You are an assistant helping an event/exhibit contractor understand and work on a specific sales opportunity. Answer using the information below -- the opportunity's details, its uploaded documents, and its estimate(s) -- plus the available tools when that's not enough. When you state a fact from a document, name the document it came from, exactly as given (e.g. "RFP Final.pdf"). When you refer to a line item, quote its exact description as given and name the estimate and section it's in. If something still isn't covered after checking, say so plainly rather than guessing.

Use the tools rather than giving up or guessing: if line items were noted as left out for length, or you need every item matching some filter, call get_line_items. If a document is mentioned above but the excerpts shown don't cover what's being asked, call get_document_excerpt on it by name before answering.

The DOCUMENTS ON THIS OPPORTUNITY list above names every document that's actually uploaded, whether or not its content made it into this prompt -- check it before concluding a document or quote doesn't exist. If the user names a vendor, a person, or a quote you don't already have excerpts for (e.g. "the Fuse quote" or "the quote from Colin Feeney"), look for a filename on that list that could plausibly be it and call get_document_excerpt on that exact filename -- don't limit yourself to whatever document happened to come up earlier in the conversation. Only tell the user no such document exists after checking that full list, not just the excerpts already shown.

When asked to check a quote or document against the estimate -- e.g. whether its items are already included, or where they'd be -- read the document's real content first (excerpts above, or get_document_excerpt), then look up each item it mentions with get_line_items (searchText is well suited to this) to report whether and where it's actually in the estimate today, rather than answering from the document alone.

When asked which items came from a specific vendor's quote or a named document (e.g. "how much are the Fuse items," "what did we get from that quote"), use get_line_items' documentName filter rather than searchText -- an item imported from a vendor's quote is described by what it IS ("Video Package," "Lighting Package"), not by which vendor quoted it, so the vendor's name usually won't match anything in searchText even when every one of those items is genuinely in the estimate.

When the user asks you to locate, find, or check whether a section, category, or tag exists (e.g. "find the Professional Services section," "does a Labor section exist"), call find_section -- it gives a definitive answer, including when something exists but currently has zero line items in it, which is a real answer to report plainly, not the same as "not found." Also call find_section first whenever you're about to use propose_line_item and aren't already certain the target name is a section (a physical container) vs. a category (a proposal-facing tag) -- guessing wrong here is exactly the kind of mistake to avoid, not something to work around silently.

You can also add a new line item with propose_line_item, when the user asks you to add, create, or price out an item. It ALWAYS lands as a draft that a person still has to review and confirm on the Line Items tab -- it never counts toward any total on its own. Because of that, don't stop to ask permission before calling it -- the draft itself is the safety check, not a yes/no question first. Call it as soon as you have enough information, and only ask the user something first when a real piece of information is genuinely missing or ambiguous (e.g. propose_line_item reports more than one matching section with the same name across different booths) -- and when you do ask, ask the SPECIFIC thing that's missing (which section, which booth) rather than a generic "should I proceed?". A section name and a category are different things (see the tool's own description) -- a request to add something "in" or "under" a named category (like "Professional Services") means category, not sectionName. If that category has no section holding it yet, the tool creates a clean, standalone one automatically rather than asking you to force it into an unrelated booth's section -- when it does this, say so plainly in your reply (e.g. "I created a new Professional Services section since none existed"). Every time you use the tool, also say plainly that it's a draft awaiting their confirmation -- never imply the estimate has already changed for real.

If the user is correcting or adjusting a line item that was just added a moment ago in this same conversation ("actually make that 500", "change the quantity to 3", "call it X instead"), use update_line_item on that same item -- quote its id exactly as shown in the propose_line_item result or in a line item listed above -- rather than calling propose_line_item again, which would leave a duplicate behind instead of a correction. update_line_item only works on drafts; if it reports the item is already confirmed, say so plainly and suggest the user make that change directly on the Line Items tab rather than retrying.

If the user asks you to create a new section/group/tab and hasn't also told you its line items in the same request, use create_section, not propose_line_item -- don't invent a line item to stand in for a section that hasn't been asked for. Sections are never nested inside each other, so a request phrased as a new section "within" or "under" some other name almost never means an existing container to nest inside -- call find_section on that name first, and if it doesn't resolve to one clear, real booth/component, ask the user directly whether the new section is project-wide or belongs to a specific booth/component, rather than guessing a groupLabel from a name that didn't check out. After create_section succeeds, ask what line items should go in it, rather than adding any yourself yet.

Whenever the user describes an item as project-wide, overall, or not tied to one specific booth/component, do NOT just pick whichever section with a matching name happens to come up (e.g. don't default to a booth-specific "Labor" section for a project-wide labor item) -- among the sections a tool actually returns, look for one whose groupLabel does NOT name a specific booth/component (an overall/summary-style group, distinct from the booth-named ones sitting alongside it in the same list). If it's genuinely not obvious which one that is, ask the user rather than guessing.

Whenever any tool returns a list of matching or available items -- sections, categories, documents, anything -- relay the COMPLETE list the tool gave you, never a shortened, sampled, or "for example" subset. Dropping an option (even accidentally, for brevity) can hide the exact one the user needed; completeness matters more than brevity here.

Whenever any tool call reports an error, an ambiguity, or a "not found," relay that to the user honestly and specifically -- what went wrong or what's missing -- instead of glossing over it, silently retrying with a guess, or claiming something succeeded when the tool result didn't confirm it.

Write like you're chatting, not drafting a report: short paragraphs, plain sentences, markdown only where it earns its place (a short bullet list for several distinct items, bold for a key number or term). Skip headings entirely, and don't preface an answer with a restatement of the question.`;

type EstimateLineItem = {
  id: string;
  description: string;
  category: string | null;
  isDraft: boolean;
  qty: { toString(): string };
  unit: string | null;
  unitCost: { toFixed(n: number): string };
  totalCost: { toFixed(n: number): string };
  // Real, already-verified grounding -- a pricing-schedule row's own
  // cell text or an AI-proposed item's verified quote (see LineItem's
  // own schema comment), never asked of the model as a guess. Null for a
  // manually added row, or one imported before this existed.
  sourceQuote: string | null;
  sourcePageNumber: number | null;
  document: { filename: string } | null;
};

function formatLineItemLine(sectionLabel: string, li: EstimateLineItem): string {
  const status = li.isDraft ? "DRAFT" : "CONFIRMED";
  const qty = `${li.qty.toString()}${li.unit ? ` ${li.unit}` : ""}`;
  const category = li.category ? ` (${li.category})` : "";
  const line = `  - [${status}] ${sectionLabel}: ${li.description} -- qty ${qty} × $${li.unitCost.toFixed(2)} = $${li.totalCost.toFixed(2)}${category} (id: ${li.id})`;
  if (!li.sourceQuote || !li.document) return line;
  const { display } = truncateForCitation(li.sourceQuote, MAX_QUOTE_CONTEXT_CHARS);
  const page = li.sourcePageNumber ? `, p.${li.sourcePageNumber}` : "";
  return `${line}\n      ↳ from "${display}" -- ${li.document.filename}${page}`;
}

// One estimate's worth of context: header stats (always included, same as
// before this rewrite) plus as many real line items as fit in whatever
// budget remains -- confirmed items first, since they're the ones a user
// is actually asking about most often, with drafts filling in behind
// them. Degrades by truncating the item list, never by dropping the
// estimate wholesale the way a whole document can be dropped below --
// losing every item for an estimate the user is actively asking about
// would be a worse failure than showing fewer of them.
function buildEstimateBlock(
  estimate: {
    name: string | null;
    versions: {
      versionNumber: number;
      isLocked: boolean;
      totalCost: { toFixed(n: number): string };
      grandTotal: { toFixed(n: number): string };
      grossMarginPct: { toFixed(n: number): string };
      sections: { name: string; groupLabel: string | null; lineItems: EstimateLineItem[] }[];
    }[];
  },
  label: string,
  remainingBudget: number,
): { block: string; charsUsed: number; omitted: number } {
  const version = estimate.versions[0];
  if (!version) return { block: "", charsUsed: 0, omitted: 0 };

  const rows = version.sections.flatMap((s) => {
    const sectionLabel = s.groupLabel ? `${s.name} (${s.groupLabel})` : s.name;
    return s.lineItems.map((li) => ({ sectionLabel, li }));
  });
  const confirmed = rows.filter((r) => !r.li.isDraft);
  const drafts = rows.filter((r) => r.li.isDraft);
  const ordered = [...confirmed, ...drafts];

  const header = [
    "",
    `ESTIMATE: ${label} (version ${version.versionNumber}${version.isLocked ? ", locked" : ", editing"}):`,
    `Total cost: $${version.totalCost.toFixed(2)} · Grand total: $${version.grandTotal.toFixed(2)} · Margin: ${version.grossMarginPct.toFixed(1)}%`,
    `${confirmed.length} confirmed line item(s), ${drafts.length} draft (unreviewed) line item(s) across ${version.sections.length} section(s).`,
  ].join("\n");

  let used = header.length;
  const lines: string[] = [];
  let omitted = 0;
  for (const { sectionLabel, li } of ordered) {
    const line = formatLineItemLine(sectionLabel, li);
    if (used + line.length + 1 > remainingBudget) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  let block = header;
  if (lines.length > 0) block += `\n${lines.join("\n")}`;
  if (omitted > 0) {
    const note = `\n(${omitted} more line item(s) not shown here for length -- ask about a specific section or category for detail.)`;
    block += note;
    used += note.length;
  }

  return { block, charsUsed: used, omitted };
}

// Renders retrieveRelevantChunks' results into one block, budget-gating
// by truncating the chunk list (dropping the least-relevant ones first --
// they're already ordered by similarity) rather than an all-or-nothing
// drop the way a whole unindexed document can be below. These chunks ARE
// the direct answer to the question just asked; losing all of them would
// be a worse failure than the old per-document dump ever risked.
function buildRetrievedChunksBlock(
  chunks: RetrievedChunk[],
  remainingBudget: number,
): { block: string; charsUsed: number; omitted: number; filenamesIncluded: string[] } {
  if (chunks.length === 0) return { block: "", charsUsed: 0, omitted: 0, filenamesIncluded: [] };

  const header = "\n\nRELEVANT DOCUMENT EXCERPTS (retrieved for this question, not the full document):";
  let used = header.length;
  const pieces: string[] = [];
  const filenames = new Set<string>();
  let omitted = 0;
  for (const chunk of chunks) {
    const piece = `\n\n[${chunk.filename}, excerpt ${chunk.chunkIndex + 1}]\n${chunk.content}`;
    if (used + piece.length > remainingBudget) {
      omitted++;
      continue;
    }
    pieces.push(piece);
    filenames.add(chunk.filename);
    used += piece.length;
  }
  if (pieces.length === 0) return { block: "", charsUsed: 0, omitted: chunks.length, filenamesIncluded: [] };

  return { block: `${header}${pieces.join("")}`, charsUsed: used, omitted, filenamesIncluded: [...filenames] };
}

export async function buildChatContext(opportunityId: string, question: string, userId: string | null = null): Promise<ChatContext> {
  const opportunity = await db.opportunity.findFirstOrThrow({
    where: { id: opportunityId },
    include: {
      company: true,
      documents: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
      // Every live estimate, not just the most recently created one --
      // an Opportunity with two named Estimates (two separate exhibits
      // for one client, see Estimate.name's own comment) used to make
      // the older one invisible to chat entirely.
      estimates: {
        where: { deletedAt: null, archivedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
          versions: {
            where: { isCurrent: true },
            take: 1,
            include: {
              sections: {
                orderBy: { sortOrder: "asc" },
                include: {
                  lineItems: {
                    // id last -- a bulk createMany (a pricing-schedule
                    // import, or 100 rows in one insert the same way
                    // chat-context-service.test.ts's own budget test
                    // does) can give every row in the batch the exact
                    // same createdAt (Postgres evaluates now() once per
                    // statement, not per row), so sortOrder+createdAt
                    // alone don't fully disambiguate order for those
                    // rows -- confirmed flaky under real concurrent
                    // insert load without this. cuid ids are
                    // monotonically increasing by construction, so this
                    // is still a stable, meaningful order, not an
                    // arbitrary one.
                    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
                    include: { document: { select: { filename: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const sections: string[] = [
    `OPPORTUNITY: ${opportunity.showName} (${opportunity.company.name})`,
    `Stage: ${opportunity.stage}${opportunity.boothNumber ? ` · Booth ${opportunity.boothNumber}` : ""}`,
    opportunity.targetMoveIn ? `Target move-in: ${opportunity.targetMoveIn.toISOString().slice(0, 10)}` : "",
    opportunity.targetMoveOut ? `Target move-out: ${opportunity.targetMoveOut.toISOString().slice(0, 10)}` : "",
  ].filter(Boolean);

  // Unconditional, regardless of budget or indexing status -- without
  // this, a document that IS indexed never appears anywhere in the
  // prompt by name unless the automatic top-K retrieval below happens to
  // surface one of its chunks for this exact question (an indexed
  // document gets filtered OUT of the plain-text listing further down,
  // see orderedDocs). A real quote/vendor document can then be
  // completely invisible to the model -- it has no name to check,
  // nothing to call get_document_excerpt on, and no way to tell "doesn't
  // exist" apart from "exists but didn't come up." This is the document
  // equivalent of find_section's problem for sections: knowing what's
  // really there has to be independent of whatever fit in a filtered
  // slice. Small and cheap -- a handful of filenames, not their content.
  if (opportunity.documents.length > 0) {
    const list = opportunity.documents
      .map((d) => `${d.filename} (${d.documentType}${d.extractionStatus !== "COMPLETE" ? `, ${d.extractionStatus.toLowerCase()}` : ""})`)
      .join(", ");
    sections.push(`DOCUMENTS ON THIS OPPORTUNITY (${opportunity.documents.length}): ${list}`);
  }

  const documentsIncluded: string[] = [];
  const documentsDropped: string[] = [];
  let remainingBudget = MAX_CONTEXT_CHARS - sections.join("\n").length;
  let lineItemsOmitted = 0;

  // Real line items before document text -- grounding in what the
  // estimate actually contains matters more than raw RFP prose, and
  // (unlike a document) an estimate can't be swapped out for a filename
  // reference if it doesn't fit.
  const multipleEstimates = opportunity.estimates.length > 1;
  opportunity.estimates.forEach((estimate, i) => {
    const label = estimate.name ?? (multipleEstimates ? `Untitled estimate ${i + 1}` : "Current estimate");
    const { block, charsUsed, omitted } = buildEstimateBlock(estimate, label, remainingBudget);
    if (block) sections.push(block);
    remainingBudget -= charsUsed;
    lineItemsOmitted += omitted;
  });

  // Split into "retrieval already covers this one" vs. "no chunks yet,
  // still needs the old full-text fallback" -- see this file's header
  // comment. Checked once per opportunity, not per document: a single
  // similarity search across every indexed chunk is what actually
  // returns the relevant excerpts below.
  const indexedDocumentIds = await getIndexedDocumentIds(opportunityId);

  if (indexedDocumentIds.size > 0) {
    const retrieved = await retrieveRelevantChunks(opportunityId, question, userId);
    const { block, charsUsed, filenamesIncluded } = buildRetrievedChunksBlock(retrieved, remainingBudget);
    if (block) {
      sections.push(block);
      remainingBudget -= charsUsed;
      documentsIncluded.push(...filenamesIncluded);
    }
  }

  const orderedDocs = [...opportunity.documents]
    .filter((d) => !indexedDocumentIds.has(d.id))
    .sort((a, b) => {
      const rank = (t: DocumentType) => {
        const i = DOCUMENT_PRIORITY.indexOf(t);
        return i === -1 ? DOCUMENT_PRIORITY.length : i;
      };
      return rank(a.documentType) - rank(b.documentType);
    });

  for (const doc of orderedDocs) {
    if (!doc.extractedText) continue; // not analyzed, unsupported, or a pricing schedule -- nothing to include
    const block = `\n\nDOCUMENT: ${doc.filename} (${doc.documentType})\n${doc.extractedText}`;
    if (block.length > remainingBudget) {
      documentsDropped.push(doc.filename);
      continue;
    }
    sections.push(block);
    remainingBudget -= block.length;
    documentsIncluded.push(doc.filename);
  }

  const systemPrompt = `${SYSTEM_PREAMBLE}\n\n${sections.join("\n")}`;
  return { systemPrompt, documentsIncluded, documentsDropped, lineItemsOmitted };
}

export async function getRecentMessages(threadId: string) {
  const messages = await db.chatMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES,
  });
  return messages.reverse();
}
