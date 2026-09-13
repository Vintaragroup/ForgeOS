import { getCalendarItems, utcAddDays, utcToday } from "@/lib/calendar";
import { buildIcsFeed, validateCalendarFeedToken } from "@/lib/calendar-feed";

// Unauthenticated by design -- a calendar app's plain background GET
// carries no session cookie at all, so this route is exempted in
// proxy.ts's allowlist and authenticates entirely via the token embedded
// in its own URL (validateCalendarFeedToken).
export async function GET(_request: Request, { params }: RouteContext<"/api/calendar-feed/[tokenParam]">) {
  const { tokenParam: raw } = await params;
  // The URL ends in .ics for calendar-app auto-detection, even though
  // Content-Type is the real signal -- strip it back off before parsing
  // the token.
  const tokenParam = raw.endsWith(".ics") ? raw.slice(0, -".ics".length) : raw;

  const user = await validateCalendarFeedToken(tokenParam);
  if (!user) return new Response("Not found", { status: 404 });

  // A generous rolling window appropriate for an indefinitely-polled
  // subscription -- NOT the narrow 7/14-day windows the Dashboard/Calendar
  // UI widgets use.
  const today = utcToday();
  const items = await getCalendarItems(user, utcAddDays(today, -30), utcAddDays(today, 180));
  const ics = buildIcsFeed(items, { calendarName: "ForgeOS" });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="forgeos.ics"',
    },
  });
}
