// The department assistant: threads, access, and one answer.
//
// Deliberately separate from chat-service.ts (the per-opportunity chat).
// That one is a working tool inside one job -- it carries tools that
// propose and update line items, and its context is that opportunity's
// documents and estimate. This one is answer-only across a department's
// own data (agreed for v1), so it has no tool loop at all: fewer moving
// parts, no way for it to write anything, and nothing to review.
//
// Everything department-specific lives in ai/assistant-registry.ts. This
// file knows about threads, access, rate limits, citations and cost --
// none of which differ between departments.

import { db } from "@/lib/db";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { renderCitationTokens } from "@/lib/ai/citation-tokens";
import { buildCitationDirectory, CITATION_INSTRUCTIONS } from "@/lib/ai/citation-tokens";
import { canUseAssistant, getDepartmentAssistant, type AssistantUser } from "@/lib/ai/assistant-registry";
import { threadTitleFrom } from "@/lib/chat-service";
import { UserError } from "@/lib/user-error";

// Same budget as opportunity chat -- one person, ten minutes.
const MESSAGE_LIMIT = 20;
const MESSAGE_WINDOW_MS = 10 * 60 * 1000;
// How much of the conversation is replayed. Long enough to follow a
// thread of questions, short enough that an old thread doesn't grow the
// prompt without bound.
const HISTORY_LIMIT = 12;

export async function listAssistantThreads(userId: string, departmentCode: string) {
  return db.chatThread.findMany({
    where: { scope: "DEPARTMENT", userId, departmentCode, archivedAt: null },
    select: { id: true, title: true, lastMessageAt: true, createdAt: true },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 30,
  });
}

export async function createAssistantThread(user: AssistantUser, departmentCode: string) {
  if (!canUseAssistant(user, departmentCode)) {
    throw new UserError("You don't have access to that department's assistant.");
  }
  if (!getDepartmentAssistant(departmentCode)) {
    throw new UserError("That department doesn't have an assistant set up yet.");
  }
  return db.chatThread.create({ data: { scope: "DEPARTMENT", userId: user.id, departmentCode } });
}

// A thread belongs to the person who started it. Admins can see any (as
// everywhere else in this app), but a rep can never open a colleague's.
export async function loadAssistantThread(user: AssistantUser, threadId: string) {
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, scope: "DEPARTMENT" },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!thread) throw new UserError("That conversation no longer exists.");
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  if (thread.userId !== user.id && !isAdmin) throw new UserError("That conversation belongs to someone else.");
  return thread;
}

export interface AssistantReply {
  id: string;
  role: string;
  content: string;
}

export async function sendAssistantMessage(user: AssistantUser, threadId: string, content: string): Promise<AssistantReply> {
  const question = content.trim();
  if (!question) throw new UserError("Type a question first.");
  await checkRateLimit(`assistant:${user.id}`, MESSAGE_LIMIT, MESSAGE_WINDOW_MS);

  const thread = await loadAssistantThread(user, threadId);
  const departmentCode = thread.departmentCode ?? "";
  if (!canUseAssistant(user, departmentCode)) throw new UserError("You don't have access to that department's assistant.");
  const assistant = getDepartmentAssistant(departmentCode);
  if (!assistant) throw new UserError("That department doesn't have an assistant set up yet.");

  // Built fresh per question: the answer should reflect the book as it is
  // now, not as it was when the thread started.
  const context = await assistant.buildContext(user);
  const client = getOpenAiClient();

  await db.chatMessage.create({ data: { threadId: thread.id, role: "user", content: question } });
  await db.chatThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: new Date(), ...(thread.title ? {} : { title: threadTitleFrom(question) }) },
  });

  const directory = buildCitationDirectory(context.citations);
  const systemPrompt = directory
    ? `${context.systemPrompt}\n\n${CITATION_INSTRUCTIONS}\n\n${directory}`
    : context.systemPrompt;

  const history = thread.messages.slice(-HISTORY_LIMIT).map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }],
  });
  await recordAiUsage({
    feature: "DEPARTMENT_ASSISTANT",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    userId: user.id,
  });

  const reply = completion.choices[0]?.message?.content?.trim() || "I couldn't come up with an answer to that.";
  const stored = await db.chatMessage.create({ data: { threadId: thread.id, role: "assistant", content: reply } });
  return { id: stored.id, role: stored.role, content: renderCitationTokens(stored.content, context.citations) };
}

// Stored messages are raw; links are rendered at read time so a citation
// always points at today's data, the same posture the opportunity chat
// takes.
export async function renderAssistantMessages(user: AssistantUser, threadId: string) {
  const thread = await loadAssistantThread(user, threadId);
  const assistant = thread.departmentCode ? getDepartmentAssistant(thread.departmentCode) : null;
  if (!assistant) return thread.messages.map((m) => ({ id: m.id, role: m.role, content: m.content }));
  const context = await assistant.buildContext(user);
  return thread.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.role === "assistant" ? renderCitationTokens(m.content, context.citations) : m.content,
  }));
}
