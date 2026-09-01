// Phase 7.3: Opportunity chat. Non-streaming, plain request/response --
// this app has exactly two client components (app-nav.tsx, confirm-form.tsx)
// today; a streamed chat UI would be the third and first with real
// client-side state. Matches the rest of the app's Server Action style
// rather than a compromise.

import { db } from "@/lib/db";
import { buildChatContext, getRecentMessages } from "@/lib/ai/chat-context-service";
import { ADVANCED_MODEL, BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { getProjectContext } from "@/lib/ai/scope-document-context";

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
