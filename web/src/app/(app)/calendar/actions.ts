"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAppBaseUrl } from "@/lib/email";
import { issueCalendarFeedToken } from "@/lib/calendar-feed";

function isAdmin(user: { systemRole: string }) {
  return user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
}

// Shared by create and update, unlike the trivial one-line isAdmin above
// -- this is a real multi-field business rule (recurrence + dateEnd are
// mutually exclusive) worth one source of truth rather than two copies
// that could drift.
function parseRecurrence(formData: FormData, dateEnd: Date | null): "NONE" | "WEEKLY" | "MONTHLY" {
  const raw = String(formData.get("recurrence") ?? "NONE");
  const recurrence = raw === "WEEKLY" || raw === "MONTHLY" ? raw : "NONE";
  if (recurrence !== "NONE" && dateEnd) {
    throw new Error("A repeating note can't have an end date.");
  }
  return recurrence;
}

export async function createCalendarEventAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");

  const title = String(formData.get("title") ?? "").trim();
  if (!title) throw new Error("A title is required.");

  const rawDate = String(formData.get("date") ?? "").trim();
  const date = new Date(rawDate);
  if (!rawDate || Number.isNaN(date.getTime())) throw new Error("Enter a valid date.");

  const rawDateEnd = String(formData.get("dateEnd") ?? "").trim();
  let dateEnd: Date | null = null;
  if (rawDateEnd) {
    dateEnd = new Date(rawDateEnd);
    if (Number.isNaN(dateEnd.getTime())) throw new Error("Enter a valid end date.");
    if (dateEnd < date) throw new Error("End date can't be before the start date.");
  }

  const recurrence = parseRecurrence(formData, dateEnd);

  const rawVisibility = String(formData.get("visibility") ?? "");
  const visibility = rawVisibility === "ORG" ? "ORG" : "PRIVATE";

  const notes = String(formData.get("notes") ?? "").trim() || null;

  await db.calendarEvent.create({
    data: { title, date, dateEnd, visibility, notes, recurrence, createdByUserId: user.id },
  });

  revalidatePath("/calendar");
  revalidatePath("/");
}

export async function deleteCalendarEventAction(eventId: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");

  const event = await db.calendarEvent.findUniqueOrThrow({ where: { id: eventId }, select: { createdByUserId: true } });
  if (event.createdByUserId !== user.id && !isAdmin(user)) {
    throw new Error("You can only delete your own calendar events.");
  }

  await db.calendarEvent.update({ where: { id: eventId }, data: { deletedAt: new Date() } });

  revalidatePath("/calendar");
  revalidatePath("/");
}

// Editing a recurring note edits the whole series (there is no
// per-occurrence edit -- see CalendarEventRecurrence's own schema
// comment). The form pre-fills from whichever occurrence's row the edit
// link was opened from, so submitting can re-anchor the entire series to
// a new date -- this falls out naturally from "one CalendarEvent row per
// series," no special-casing needed.
export async function updateCalendarEventAction(eventId: string, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");

  const event = await db.calendarEvent.findUniqueOrThrow({ where: { id: eventId }, select: { createdByUserId: true } });
  if (event.createdByUserId !== user.id && !isAdmin(user)) {
    throw new Error("You can only edit your own calendar events.");
  }

  const title = String(formData.get("title") ?? "").trim();
  if (!title) throw new Error("A title is required.");

  const rawDate = String(formData.get("date") ?? "").trim();
  const date = new Date(rawDate);
  if (!rawDate || Number.isNaN(date.getTime())) throw new Error("Enter a valid date.");

  const rawDateEnd = String(formData.get("dateEnd") ?? "").trim();
  let dateEnd: Date | null = null;
  if (rawDateEnd) {
    dateEnd = new Date(rawDateEnd);
    if (Number.isNaN(dateEnd.getTime())) throw new Error("Enter a valid end date.");
    if (dateEnd < date) throw new Error("End date can't be before the start date.");
  }

  const recurrence = parseRecurrence(formData, dateEnd);

  const rawVisibility = String(formData.get("visibility") ?? "");
  const visibility = rawVisibility === "ORG" ? "ORG" : "PRIVATE";

  const notes = String(formData.get("notes") ?? "").trim() || null;

  await db.calendarEvent.update({
    where: { id: eventId },
    data: { title, date, dateEnd, visibility, notes, recurrence },
  });

  revalidatePath("/calendar");
  revalidatePath("/");
  // Back to the (possibly newly-edited) date's day view, not necessarily
  // wherever the edit form was opened from -- the user may have changed
  // the date.
  redirect(`/calendar/day/${date.toISOString().slice(0, 10)}`);
}

export async function issueCalendarFeedTokenAction() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");
  const rawToken = await issueCalendarFeedToken(user.id);
  redirect(`/calendar?feedUrl=${encodeURIComponent(`${getAppBaseUrl()}/api/calendar-feed/${rawToken}.ics`)}`);
}
