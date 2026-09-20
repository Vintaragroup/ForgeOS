"use server";

import { getCurrentUser } from "@/lib/auth";
import {
  createAssistantThread,
  listAssistantThreads,
  renderAssistantMessages,
  sendAssistantMessage,
} from "@/lib/assistant-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import type { AssistantUser } from "@/lib/ai/assistant-registry";

// Called directly from the AssistantWidget client component (not via
// <form action>), same pattern as the opportunity chat's own widget
// actions. Each one re-checks the user itself -- a Server Action is
// independently reachable, and the widget being rendered is not a
// permission check.

async function requireUser(): Promise<AssistantUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  return {
    id: user.id,
    name: user.name,
    systemRole: user.systemRole,
    departmentCode: user.departmentCode,
    isSalesManager: user.isSalesManager,
  };
}

export interface AssistantThreadSummary {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
}

export interface AssistantMessageData {
  id: string;
  role: string;
  content: string;
}

function toSummary(thread: { id: string; title: string | null; lastMessageAt: Date | null }): AssistantThreadSummary {
  return { id: thread.id, title: thread.title, lastMessageAt: thread.lastMessageAt?.toISOString() ?? null };
}

export async function startAssistantThreadAction(departmentCode: string): Promise<AssistantThreadSummary> {
  const user = await requireUser();
  return toSummary(await createAssistantThread(user, departmentCode));
}

export async function loadAssistantThreadAction(threadId: string): Promise<AssistantMessageData[]> {
  const user = await requireUser();
  return renderAssistantMessages(user, threadId);
}

export async function listAssistantThreadsAction(departmentCode: string): Promise<AssistantThreadSummary[]> {
  const user = await requireUser();
  return (await listAssistantThreads(user.id, departmentCode)).map(toSummary);
}

export async function sendAssistantMessageAction(threadId: string, content: string): Promise<AssistantMessageData> {
  const user = await requireUser();
  try {
    return await sendAssistantMessage(user, threadId, content);
  } catch (err) {
    // The raw error names an env var; the person reading it can't act on
    // that, and an admin can.
    if (err instanceof AiNotConfiguredError) {
      throw new Error("The assistant isn't configured on this server yet -- an admin needs to add an OpenAI key.");
    }
    throw err;
  }
}
