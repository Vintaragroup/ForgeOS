// Phase 7.3: Opportunity chat. Non-streaming, plain request/response --
// this app has exactly two client components (app-nav.tsx, confirm-form.tsx)
// today; a streamed chat UI would be the third and first with real
// client-side state. Matches the rest of the app's Server Action style
// rather than a compromise.

import { db } from "@/lib/db";
import { buildChatContext, getRecentMessages, MAX_QUOTE_CONTEXT_CHARS } from "@/lib/ai/chat-context-service";
import { ADVANCED_MODEL, BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { getProjectContext } from "@/lib/ai/scope-document-context";
import { citationHref, truncateForCitation, type CitableQuote } from "@/lib/citation";

const CHAT_MESSAGE_LIMIT = 20;
const CHAT_MESSAGE_WINDOW_MS = 10 * 60 * 1000;

async function getOrCreateThread(opportunityId: string) {
  const existing = await db.chatThread.findUnique({ where: { opportunityId } });
  if (existing) return existing;
  return db.chatThread.create({ data: { opportunityId } });
}

export async function sendMessage(opportunityId: string, userId: string, content: string) {
  // First cost-bearing action in this app -- rate-limited by user, same
  // key shape as login/change-password (see rate-limit.ts's call sites).
  await checkRateLimit(`chat:${userId}`, CHAT_MESSAGE_LIMIT, CHAT_MESSAGE_WINDOW_MS);

  const client = getOpenAiClient();
  const thread = await getOrCreateThread(opportunityId);

  await db.chatMessage.create({ data: { threadId: thread.id, role: "user", content } });

  const [{ systemPrompt, documentsDropped, lineItemsOmitted }, history, projectContext] = await Promise.all([
    buildChatContext(opportunityId),
    getRecentMessages(thread.id),
    getProjectContext(opportunityId),
  ]);

  // Answering across 2+ named Estimates on one Opportunity is the same
  // cross-topic attribution judgment call document-summary-service.ts and
  // meeting-notes-summary-service.ts already reserve ADVANCED_MODEL for --
  // confirmed there that BASIC_MODEL misattributes unambiguous content
  // between two real projects. The common single-estimate case (or an
  // Opportunity with no named Estimates to disambiguate between) stays on
  // BASIC_MODEL.
  const model = projectContext.estimates.length > 0 ? ADVANCED_MODEL : BASIC_MODEL;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ],
  });

  await recordAiUsage({
    userId,
    feature: "CHAT",
    model,
    usage: completion.usage,
    opportunityId,
  });

  const reply = completion.choices[0]?.message?.content?.trim() || "(no response)";
  const assistantMessage = await db.chatMessage.create({
    data: { threadId: thread.id, role: "assistant", content: reply },
  });

  return { assistantMessage, documentsDropped, lineItemsOmitted };
}

export async function getThreadMessages(opportunityId: string) {
  const thread = await db.chatThread.findUnique({
    where: { opportunityId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  return thread?.messages ?? [];
}

// Every live estimate's current-version line items, shaped for
// linkifyMentions (citation.ts) to match against a chat reply and turn a
// description the assistant echoes back into a real link straight to
// that row (estimateId comes from the Estimate each item's version rolls
// up to, not a column on LineItem itself). Read fresh on every call
// rather than cached -- always reflects the estimate as it stands right
// now, not as it stood whenever a given message was actually sent, same
// posture as re-resolving a document's viewer link on every render.
export async function getCitableLineItems(opportunityId: string) {
  const estimates = await db.estimate.findMany({
    where: { opportunityId, deletedAt: null, archivedAt: null },
    select: {
      id: true,
      versions: {
        where: { isCurrent: true },
        take: 1,
        select: { sections: { select: { lineItems: { select: { id: true, description: true } } } } },
      },
    },
  });
  return estimates.flatMap((estimate) =>
    estimate.versions.flatMap((version) =>
      version.sections.flatMap((section) =>
        section.lineItems.map((li) => ({ id: li.id, estimateId: estimate.id, description: li.description })),
      ),
    ),
  );
}

// Real citations for linkifyMentions -- every live estimate's current-
// version line items that carry a verified sourceQuote (a pricing-
// schedule row's own cell text, or an AI-proposed item's verified quote;
// see LineItem's own schema comment), turned into a precise citationHref
// straight to that quote's exact page in the source document. This is
// the actual "structured citation" half of chat Phase 2 -- unlike
// getCitableLineItems' description matching above, there's nothing
// guessed here: the quote/page/document link already existed and was
// already verified before chat ever surfaced it (same link
// LineItemsTable's own sourceHref uses on the Estimate page).
export async function getCitableQuotes(opportunityId: string): Promise<CitableQuote[]> {
  const estimates = await db.estimate.findMany({
    where: { opportunityId, deletedAt: null, archivedAt: null },
    select: {
      versions: {
        where: { isCurrent: true },
        take: 1,
        select: {
          sections: {
            select: {
              lineItems: {
                where: { sourceQuote: { not: null }, documentId: { not: null } },
                select: {
                  sourceQuote: true,
                  sourcePageNumber: true,
                  document: { select: { id: true, mimeType: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const items = estimates.flatMap((e) => e.versions.flatMap((v) => v.sections.flatMap((s) => s.lineItems)));

  return items.flatMap((li) => {
    if (!li.sourceQuote || !li.document) return [];
    // The truncated form is what the model actually saw in its context
    // (chat-context-service.ts's formatLineItemLine) and so the only form
    // it can plausibly echo back -- citationHref itself still gets the
    // FULL sourceQuote, since the document viewer needs the real text to
    // find and highlight it on the page, not a truncated prefix of it.
    const { matchable } = truncateForCitation(li.sourceQuote, MAX_QUOTE_CONTEXT_CHARS);
    const href = citationHref(opportunityId, li.document, { sourceQuote: li.sourceQuote, pageNumber: li.sourcePageNumber });
    if (!href || matchable.length === 0) return [];
    return [{ match: matchable, href }];
  });
}
