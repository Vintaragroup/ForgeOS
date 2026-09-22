"use server";

import { getCurrentUser } from "@/lib/auth";
import {
  createAssistantThread,
  listAssistantThreads,
  renderAssistantMessages,
  sendAssistantMessage,
} from "@/lib/assistant-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { UserError } from "@/lib/user-error";
import type { AssistantUser } from "@/lib/ai/assistant-registry";

// Called directly from the AssistantWidget client component (not via
// <form action>), same pattern as the opportunity chat's own widget
// actions. Each one re-checks the user itself -- a Server Action is
// independently reachable, and the widget being rendered is not a
// permission check.
//
// They RETURN their expected failures rather than throwing them. Next.js
// redacts every error thrown out of a Server Action in production, so a
// thrown UserError reached the widget as "Minified React error #441" --
// which is what a Graphics user saw on opening the Sales assistant, and
// what anyone would have seen instead of "an admin needs to add an OpenAI
// key". Same reasoning as user-error.ts: a message meant to be READ has to
// come back as a value. Anything unexpected still throws, so internals
// never get echoed into the panel.

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

export type AssistantResult<T> = { ok: true; value: T } | { ok: false; error: string };

// UserError is the "expected, and worth showing" case -- an access denial,
// an unconfigured server. Everything else propagates.
async function attempt<T>(fn: () => Promise<T>): Promise<AssistantResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message };
    if (err instanceof AiNotConfiguredError) {
      // The raw error names an env var; the person reading it can't act on
      // that, and an admin can.
      return { ok: false, error: "The assistant isn't configured on this server yet -- an admin needs to add an OpenAI key." };
    }
    throw err;
  }
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

export async function startAssistantThreadAction(
  departmentCode: string,
): Promise<AssistantResult<AssistantThreadSummary>> {
  return attempt(async () => toSummary(await createAssistantThread(await requireUser(), departmentCode)));
}

export async function loadAssistantThreadAction(threadId: string): Promise<AssistantResult<AssistantMessageData[]>> {
  return attempt(async () => renderAssistantMessages(await requireUser(), threadId));
}

export async function listAssistantThreadsAction(
  departmentCode: string,
): Promise<AssistantResult<AssistantThreadSummary[]>> {
  return attempt(async () => {
    const user = await requireUser();
    return (await listAssistantThreads(user.id, departmentCode)).map(toSummary);
  });
}

export async function sendAssistantMessageAction(
  threadId: string,
  content: string,
): Promise<AssistantResult<AssistantMessageData>> {
  return attempt(async () => sendAssistantMessage(await requireUser(), threadId, content));
}
