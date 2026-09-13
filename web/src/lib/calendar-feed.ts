// Personal .ics calendar-feed subscription tokens -- same hash-only-
// persisted, ${rowId}.${rawToken} shape as the artwork portal's magic
// links (artwork-portal-session.ts's hashInviteToken/timingSafeHashEquals),
// replicated rather than imported: CalendarFeedToken is a genuinely
// unrelated resource (a personal feed, not an ArtworkOrder), and sharing a
// crypto helper module across two unrelated domains would couple them for
// no real benefit. "." (not ":") is the URL delimiter -- a path segment
// carries a literal "." with no percent-encoding at all, unlike ":",
// avoiding the artwork portal's own encode/decode-before-split step
// entirely.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { SystemRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getAppBaseUrl } from "@/lib/email";
import { CALENDAR_ITEM_TYPE_LABELS, utcAddDays, type CalendarItem } from "@/lib/calendar";

function hashFeedToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function timingSafeHashEquals(hashA: string, hashB: string): boolean {
  const bufA = Buffer.from(hashA);
  const bufB = Buffer.from(hashB);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export type CalendarFeedUser = { id: string; systemRole: SystemRole; departmentCode: string | null };

// Revokes any existing active token for this user first -- a calendar
// feed is meant to have exactly one live URL at a time, so "regenerate"
// must truly invalidate the old one, not add a second valid one alongside
// it.
export async function issueCalendarFeedToken(userId: string): Promise<string> {
  await db.calendarFeedToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const rawToken = randomBytes(32).toString("hex");
  const row = await db.calendarFeedToken.create({
    data: { userId, tokenHash: hashFeedToken(rawToken) },
  });
  // The only moment the raw token is ever available -- only tokenHash is
  // ever persisted, so once this returns, the caller must capture and
  // show it immediately or it's gone for good, same show-once tradeoff as
  // a Stripe/GitHub API key. Do not try to build a way to redisplay it.
  return `${row.id}.${rawToken}`;
}

// For /calendar to know whether to show "Get subscribe link" vs "Feed
// active -- Regenerate", without ever touching the hash.
export async function hasActiveCalendarFeedToken(userId: string): Promise<boolean> {
  const row = await db.calendarFeedToken.findFirst({ where: { userId, revokedAt: null }, select: { id: true } });
  return row !== null;
}

// The one function the unauthenticated /api/calendar-feed/[tokenParam]
// route calls to authenticate a plain background GET -- no cookies, no
// Next request context needed.
export async function validateCalendarFeedToken(tokenParam: string): Promise<CalendarFeedUser | null> {
  const [id, rawToken] = tokenParam.split(".");
  if (!id || !rawToken) return null;

  const row = await db.calendarFeedToken.findUnique({ where: { id } });
  if (!row || row.revokedAt) return null;
  if (!timingSafeHashEquals(row.tokenHash, hashFeedToken(rawToken))) return null;

  return db.user.findUnique({
    where: { id: row.userId, deletedAt: null },
    select: { id: true, systemRole: true, departmentCode: true },
  });
}

const ICS_LINE_FOLD_LIMIT = 75;

// RFC 5545 §3.1: a content line longer than 75 octets (UTF-8 bytes, not
// characters) folds into a CRLF + single-space continuation. Never cuts
// inside a multi-byte UTF-8 sequence.
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= ICS_LINE_FOLD_LIMIT) return line;

  const chunks: string[] = [];
  let start = 0;
  let limit = ICS_LINE_FOLD_LIMIT;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = ICS_LINE_FOLD_LIMIT - 1; // the continuation's own leading space counts
  }
  return chunks.join("\r\n ");
}

// RFC 5545 §3.3.11 TEXT escaping -- backslash first, so the backslashes
// this inserts for ;/,/\n are never re-escaped by a later step.
function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function fmtIcsDateTimeUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function fmtIcsDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// Hand-rolled ICS/RFC-5545 text -- a VCALENDAR wrapper plus one VEVENT per
// CalendarItem is narrow enough (string templating, not a real calendar
// engine) that this avoids a new dependency for it; no ICS library is
// installed.
export function buildIcsFeed(items: CalendarItem[], opts: { calendarName: string }): string {
  const now = fmtIcsDateTimeUtc(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ForgeOS//Calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(opts.calendarName)}`,
  ];

  for (const item of items) {
    lines.push("BEGIN:VEVENT");
    // item.id is already globally unique per source row (e.g.
    // "TASK_DUE:cuid"), so it's a safe UID as-is.
    lines.push(`UID:${item.id}@forgeos.app`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART;VALUE=DATE:${fmtIcsDate(item.dateStart)}`);
    if (item.dateEnd) {
      // DTEND is EXCLUSIVE per RFC 5545 §3.6.1 -- a 2-day all-day event
      // needs DTEND == end+1 day, or every real calendar app renders it
      // as ending one day early.
      lines.push(`DTEND;VALUE=DATE:${fmtIcsDate(utcAddDays(item.dateEnd, 1))}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(item.title)}`);
    lines.push(`DESCRIPTION:${escapeIcsText(CALENDAR_ITEM_TYPE_LABELS[item.type])}`);
    lines.push(`URL:${getAppBaseUrl()}${item.href}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  // RFC 5545 §3.1 requires CRLF line terminators.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
