"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { confirmActivity, logTouch, snoozeQueueItem, unsnoozeQueueItem } from "@/lib/sales-actions";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";
import type { SalesQueue } from "@/generated/prisma/enums";

// The queue buttons on /sales. Each action re-checks the user itself: a
// Server Action is independently reachable, and a rendered button is not a
// permission check.
//
// Everything here is scoped to the acting user -- a touch is logged as
// them, a snooze hides the row for them alone. There's deliberately no
// ?rep= equivalent: a manager viewing someone else's book can read it, but
// acting on it would put words in that rep's mouth.

const QUEUES: SalesQueue[] = ["FOLLOW_UP", "PAST_DUE", "STALLED_DEAL", "WIN_BACK"];

async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  return user;
}

function revalidate() {
  revalidatePath("/sales");
}

function queueOrThrow(raw: FormDataEntryValue | null): SalesQueue {
  const value = String(raw ?? "");
  if (!QUEUES.includes(value as SalesQueue)) throw new UserError("That queue doesn't exist.");
  return value as SalesQueue;
}

export async function logTouchAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const result = await catchUserError(async () => {
    const user = await requireUser();
    const companyId = String(formData.get("companyId") ?? "").trim();
    if (!companyId) throw new UserError("Which client did you contact?");
    await logTouch({
      companyId,
      byUserId: user.id,
      mode: String(formData.get("mode") ?? "Call"),
      note: String(formData.get("note") ?? ""),
    });
  });
  if (!result) revalidate();
  return result;
}

export async function snoozeAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const result = await catchUserError(async () => {
    const user = await requireUser();
    const targetKey = String(formData.get("targetKey") ?? "").trim();
    if (!targetKey) throw new UserError("Nothing to snooze.");
    const days = Number(formData.get("days"));
    await snoozeQueueItem({
      userId: user.id,
      queue: queueOrThrow(formData.get("queue")),
      targetKey,
      days,
      note: String(formData.get("note") ?? ""),
    });
  });
  if (!result) revalidate();
  return result;
}

export async function unsnoozeAction(queue: string, targetKey: string): Promise<ActionResult> {
  const result = await catchUserError(async () => {
    const user = await requireUser();
    await unsnoozeQueueItem({ userId: user.id, queue: queueOrThrow(queue), targetKey });
  });
  if (!result) revalidate();
  return result;
}

export async function confirmActivityAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const result = await catchUserError(async () => {
    const user = await requireUser();
    const salesmateId = String(formData.get("salesmateId") ?? "").trim();
    if (!salesmateId) throw new UserError("Nothing to confirm.");
    await confirmActivity({ salesmateId, userId: user.id });
  });
  if (!result) revalidate();
  return result;
}
