// Phase 7.3: assembles the system prompt for Opportunity chat. No
// vector-db/RAG infra exists in this app (see Phase 7 plan's own
// reasoning) -- so this is context-stuffing within a character budget,
// not retrieval. Priority order determines what survives if a corpus is
// larger than the budget; every real document in data/RFP/superbowl fits
// comfortably within it today.

import { db } from "@/lib/db";
import type { DocumentType } from "@/generated/prisma/enums";

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
const SYSTEM_PREAMBLE = `You are an assistant helping an event/exhibit contractor understand a specific sales opportunity. Answer using only the information below -- the opportunity's details, its uploaded documents, and its estimate(s). When you state a fact from a document, name the document it came from, exactly as given (e.g. "RFP Final.pdf"). When you refer to a line item, quote its exact description as given and name the estimate and section it's in. If something isn't covered by the material below, say so plainly rather than guessing.

Write like you're chatting, not drafting a report: short paragraphs, plain sentences, markdown only where it earns its place (a short bullet list for several distinct items, bold for a key number or term). Skip headings entirely, and don't preface an answer with a restatement of the question.`;

type EstimateLineItem = {
  description: string;
  category: string | null;
  isDraft: boolean;
  qty: { toString(): string };
  unit: string | null;
  unitCost: { toFixed(n: number): string };
  totalCost: { toFixed(n: number): string };
};

function formatLineItemLine(sectionLabel: string, li: EstimateLineItem): string {
  const status = li.isDraft ? "DRAFT" : "CONFIRMED";
  const qty = `${li.qty.toString()}${li.unit ? ` ${li.unit}` : ""}`;
  const category = li.category ? ` (${li.category})` : "";
  return `  - [${status}] ${sectionLabel}: ${li.description} -- qty ${qty} × $${li.unitCost.toFixed(2)} = $${li.totalCost.toFixed(2)}${category}`;
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

export async function buildChatContext(opportunityId: string): Promise<ChatContext> {
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
                include: { lineItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
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

  const orderedDocs = [...opportunity.documents].sort((a, b) => {
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
