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

  const rawVisibility = String(formData.get("visibility") ?? "");
  const visibility = rawVisibility === "ORG" ? "ORG" : "PRIVATE";

  const notes = String(formData.get("notes") ?? "").trim() || null;

  await db.calendarEvent.create({
    data: { title, date, dateEnd, visibility, notes, createdByUserId: user.id },
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

export async function issueCalendarFeedTokenAction() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");
  const rawToken = await issueCalendarFeedToken(user.id);
  redirect(`/calendar?feedUrl=${encodeURIComponent(`${getAppBaseUrl()}/api/calendar-feed/${rawToken}.ics`)}`);
}
