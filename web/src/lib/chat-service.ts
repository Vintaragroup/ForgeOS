// Phase 7.3: Opportunity chat. Non-streaming, plain request/response --
// this app has exactly two client components (app-nav.tsx, confirm-form.tsx)
// today; a streamed chat UI would be the third and first with real
// client-side state. Matches the rest of the app's Server Action style
// rather than a compromise.

import { db } from "@/lib/db";
import { buildChatContext, getRecentMessages } from "@/lib/ai/chat-context-service";
import { BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { checkRateLimit } from "@/lib/rate-limit";

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

  const [{ systemPrompt, documentsDropped }, history] = await Promise.all([
    buildChatContext(opportunityId),
    getRecentMessages(thread.id),
  ]);

  const completion = await client.chat.completions.create({
    model: BASIC_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ],
  });

  await recordAiUsage({
    userId,
    feature: "CHAT",
    model: BASIC_MODEL,
    usage: completion.usage,
    opportunityId,
  });

  const reply = completion.choices[0]?.message?.content?.trim() || "(no response)";
  const assistantMessage = await db.chatMessage.create({
    data: { threadId: thread.id, role: "assistant", content: reply },
  });

  return { assistantMessage, documentsDropped };
}

export async function getThreadMessages(opportunityId: string) {
  const thread = await db.chatThread.findUnique({
    where: { opportunityId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  return thread?.messages ?? [];
}
