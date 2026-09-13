import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCalendarItems, utcToday, utcAddDays, CALENDAR_ITEM_TYPE_LABELS, type CalendarItem, type CalendarItemTone } from "@/lib/calendar";
import { PageHeader, Card, Field, SelectField, Button } from "@/components/ui";
import { createCalendarEventAction, deleteCalendarEventAction } from "./actions";

export const dynamic = "force-dynamic";

const AGENDA_WINDOW_DAYS = 14;

// Solid-fill variant of StatusChip's own tone vocabulary -- StatusChip's
// pale backgrounds read fine as a small pill but disappear as a full-width
// month-grid bar, so bars get a deeper fill of the same hue instead of a
// new color scheme.
const TONE_BAR: Record<CalendarItemTone, string> = {
  neutral: "bg-neutral-400 text-white",
  info: "bg-brand-navy text-white",
  warning: "bg-brand-tangerine text-white",
  good: "bg-brand-teal text-white",
  critical: "bg-red-500 text-white",
};

const TONE_PILL: Record<CalendarItemTone, string> = {
  neutral: "bg-neutral-100 text-neutral-600",
  info: "bg-brand-navy/10 text-brand-navy",
  warning: "bg-brand-tan text-amber-900",
  good: "bg-brand-teal-pale text-teal-800",
  critical: "bg-red-50 text-red-700",
};

// Every date this page renders is stored as UTC midnight (every source
// field is set through a plain <input type="date">, which the Date
// constructor parses as UTC midnight -- the same trap opportunity-name.ts's
// own comment documents). date-fns's calendar functions read a Date's
// LOCAL getters, so using them here would silently misplace every item by
// a day in any timezone behind UTC (confirmed live: a note dated the 15th
// rendered under the 14th). Every day-bucketing/formatting helper below
// works in UTC instead, matching how these dates are actually stored.
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isSameUtcDay(a: Date, b: Date): boolean {
  return utcDayKey(a) === utcDayKey(b);
}
function isSameUtcMonth(a: Date, monthStart: Date): boolean {
  return a.getUTCFullYear() === monthStart.getUTCFullYear() && a.getUTCMonth() === monthStart.getUTCMonth();
}
function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function utcMonthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}
function utcAddMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function utcStartOfWeek(d: Date): Date {
  return utcAddDays(d, -d.getUTCDay());
}
function utcEndOfWeek(d: Date): Date {
  return utcAddDays(d, 6 - d.getUTCDay());
}
function fmtMonthTitle(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}
function fmtDay(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}
function fmtMonthParam(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function parseMonthParam(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(Number(m[1]), month - 1, 1));
}

function chunkWeeks(days: Date[]): Date[][] {
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

// A multi-day item (event window, move window, a CUSTOM item with an end
// date) is clamped to one week row and rendered as a single spanning bar
// segment for that row -- an item crossing 3 weeks becomes 3 segments, one
// per row, the standard month-calendar spanning technique. Rounded caps
// only apply where the segment is the item's true start/end, so the shape
// reads as one continuous bar across row wraps.
function weekBarSegments(items: CalendarItem[], weekStart: Date, weekEnd: Date) {
  return items
    .filter((item) => item.dateEnd && item.dateStart <= weekEnd && item.dateEnd >= weekStart)
    .map((item) => {
      const clampedStart = item.dateStart < weekStart ? weekStart : item.dateStart;
      const clampedEnd = item.dateEnd! > weekEnd ? weekEnd : item.dateEnd!;
      const startCol = Math.round((utcMidnight(clampedStart).getTime() - utcMidnight(weekStart).getTime()) / 86_400_000) + 1;
      const span = Math.round((utcMidnight(clampedEnd).getTime() - utcMidnight(clampedStart).getTime()) / 86_400_000) + 1;
      return {
        item,
        startCol,
        span,
        isStart: isSameUtcDay(clampedStart, item.dateStart),
        isEnd: isSameUtcDay(clampedEnd, item.dateEnd!),
      };
    });
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { month } = await searchParams;
  const today = utcToday();
  const parsedMonth = month ? parseMonthParam(month) : null;
  const monthStart = parsedMonth ?? utcMonthStart(today);
  const monthEndDate = utcMonthEnd(monthStart);
  const gridStart = utcStartOfWeek(monthStart);
  const gridEnd = utcEndOfWeek(monthEndDate);
  const days: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = utcAddDays(d, 1)) days.push(d);
  const weeks = chunkWeeks(days);

  const [gridItems, agendaItems] = await Promise.all([
    getCalendarItems(user, gridStart, gridEnd),
    getCalendarItems(user, today, utcAddDays(today, AGENDA_WINDOW_DAYS)),
  ]);

  const pointItemsByDay = new Map<string, CalendarItem[]>();
  for (const item of gridItems) {
    if (item.dateEnd) continue;
    const key = utcDayKey(item.dateStart);
    const bucket = pointItemsByDay.get(key);
    if (bucket) bucket.push(item);
    else pointItemsByDay.set(key, [item]);
  }

  const prevMonth = fmtMonthParam(utcAddMonths(monthStart, -1));
  const nextMonth = fmtMonthParam(utcAddMonths(monthStart, 1));
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";

  return (
    <div>
      <PageHeader
        title={fmtMonthTitle(monthStart)}
        action={
          <div className="flex items-center gap-2">
            <Link href={`/calendar?month=${prevMonth}`} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              ← Prev
            </Link>
            <Link href="/calendar" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              Today
            </Link>
            <Link href={`/calendar?month=${nextMonth}`} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              Next →
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-50 text-center text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="py-2">
                {d}
              </div>
            ))}
          </div>
          {weeks.map((week, wi) => {
            const weekStart = week[0];
            const weekEnd = week[6];
            const segments = weekBarSegments(gridItems, weekStart, weekEnd);
            return (
              <div key={wi} className="relative border-b border-neutral-100 last:border-b-0">
                <div className="grid grid-cols-7">
                  {week.map((day) => {
                    const key = utcDayKey(day);
                    const points = pointItemsByDay.get(key) ?? [];
                    const visible = points.slice(0, 3);
                    const overflow = points.length - visible.length;
                    return (
                      <div
                        key={key}
                        className={`min-h-28 border-r border-neutral-100 p-1.5 last:border-r-0 ${
                          isSameUtcMonth(day, monthStart) ? "" : "bg-neutral-50/60"
                        }`}
                      >
                        <div
                          className={`mb-1 text-xs font-medium ${
                            isSameUtcDay(day, today)
                              ? "flex h-5 w-5 items-center justify-center rounded-full bg-brand-black text-white"
                              : isSameUtcMonth(day, monthStart)
                                ? "text-neutral-700"
                                : "text-neutral-400"
                          }`}
                        >
                          {day.getUTCDate()}
                        </div>
                        {segments.length > 0 && <div className="h-[1.15rem]" aria-hidden="true" />}
                        <div className="flex flex-col gap-0.5">
                          {visible.map((item) => (
                            <Link
                              key={item.id}
                              href={item.href}
                              className={`truncate rounded px-1 py-0.5 text-[11px] font-medium ${TONE_PILL[item.tone]}`}
                              title={item.title}
                            >
                              {item.title}
                            </Link>
                          ))}
                          {overflow > 0 && <span className="px-1 text-[11px] text-neutral-400">+{overflow} more</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {segments.length > 0 && (
                  <div className="pointer-events-none absolute left-0 right-0 top-6 grid grid-cols-7 gap-y-[3px]">
                    {segments.map(({ item, startCol, span, isStart, isEnd }) => (
                      <Link
                        key={item.id}
                        href={item.href}
                        className={`pointer-events-auto truncate px-2 py-0.5 text-[11px] font-medium ${TONE_BAR[item.tone]} ${
                          isStart ? "rounded-l-full" : ""
                        } ${isEnd ? "rounded-r-full" : ""}`}
                        style={{ gridColumn: `${startCol} / span ${span}` }}
                        title={item.title}
                      >
                        {item.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Next {AGENDA_WINDOW_DAYS} days
            </h2>
            {agendaItems.length === 0 ? (
              <p className="text-sm text-neutral-400">Nothing coming up.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {agendaItems.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <Link href={item.href} className="block truncate font-medium text-neutral-900 hover:underline">
                        {item.title}
                      </Link>
                      <div className="text-xs text-neutral-500">
                        {CALENDAR_ITEM_TYPE_LABELS[item.type]} · {fmtDay(item.dateStart)}
                        {item.dateEnd ? `–${fmtDay(item.dateEnd)}` : ""}
                      </div>
                    </div>
                    {item.type === "CUSTOM" && (item.ownerId === user.id || isAdmin) && (
                      // item.id is the composite `CUSTOM:${event.id}` (see
                      // calendar.ts) -- strip the prefix back to the real
                      // CalendarEvent id the action needs to look up.
                      <form action={deleteCalendarEventAction.bind(null, item.id.slice("CUSTOM:".length))}>
                        <button type="submit" aria-label="Delete" className="text-neutral-400 hover:text-red-600">
                          ✕
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card id="add-event" className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Add a note</h2>
            <form action={createCalendarEventAction} className="flex flex-col gap-3">
              <Field label="Title" name="title" required />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date" name="date" type="date" required />
                <Field label="End date (optional)" name="dateEnd" type="date" />
              </div>
              <SelectField
                label="Visibility"
                name="visibility"
                defaultValue="PRIVATE"
                options={[
                  { value: "PRIVATE", label: "Just me" },
                  { value: "ORG", label: "Everyone" },
                ]}
              />
              <Button>Add to calendar</Button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
