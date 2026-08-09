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
}

const SYSTEM_PREAMBLE = `You are an assistant helping an event/exhibit contractor understand a specific sales opportunity. Answer using only the information below -- the opportunity's details, its uploaded documents, and its current estimate. When you state a fact from a document, name the document it came from. If something isn't covered by the material below, say so plainly rather than guessing.`;

export async function buildChatContext(opportunityId: string): Promise<ChatContext> {
  const opportunity = await db.opportunity.findFirstOrThrow({
    where: { id: opportunityId },
    include: {
      company: true,
      documents: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
      estimates: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          versions: {
            where: { isCurrent: true },
            take: 1,
            include: { sections: { include: { lineItems: true } } },
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

  const version = opportunity.estimates[0]?.versions[0];
  if (version) {
    const allLineItems = version.sections.flatMap((s) => s.lineItems);
    const confirmed = allLineItems.filter((li) => !li.isDraft);
    const drafts = allLineItems.filter((li) => li.isDraft);
    sections.push(
      "",
      `CURRENT ESTIMATE (version ${version.versionNumber}${version.isLocked ? ", locked" : ", editing"}):`,
      `Total cost: $${version.totalCost.toFixed(2)} · Grand total: $${version.grandTotal.toFixed(2)} · Margin: ${version.grossMarginPct.toFixed(1)}%`,
      `${confirmed.length} confirmed line item(s), ${drafts.length} draft (unreviewed) line item(s) across ${version.sections.length} section(s).`,
    );
  }

  const documentsIncluded: string[] = [];
  const documentsDropped: string[] = [];
  let remainingBudget = MAX_CONTEXT_CHARS - sections.join("\n").length;

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
  return { systemPrompt, documentsIncluded, documentsDropped };
}

export async function getRecentMessages(threadId: string) {
  const messages = await db.chatMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES,
  });
  return messages.reverse();
}
