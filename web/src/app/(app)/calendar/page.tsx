import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import {
  getCalendarItems,
  getUpcomingWithOverdue,
  isOverdueItem,
  isGroupShown,
  utcToday,
  utcAddDays,
  CALENDAR_ITEM_TYPE_LABELS,
  CALENDAR_FILTER_GROUPS,
  type CalendarItem,
  type CalendarItemTone,
} from "@/lib/calendar";
import { hasActiveCalendarFeedToken } from "@/lib/calendar-feed";
import { PageHeader, Card, Field, SelectField, Button } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { CopyLinkBanner } from "@/components/copy-link-banner";
import { createCalendarEventAction, deleteCalendarEventAction, issueCalendarFeedTokenAction } from "./actions";

export const dynamic = "force-dynamic";

const AGENDA_WINDOW_DAYS = 14;

const TAB_BASE = "rounded-md border px-3 py-1.5 text-sm font-medium";
const TAB_ACTIVE = `${TAB_BASE} border-brand-navy bg-brand-navy text-white`;
const TAB_INACTIVE = `${TAB_BASE} border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50`;

const NAV_LINK_CLASS = "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50";

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
function fmtDayParam(d: Date): string {
  return utcDayKey(d);
}
function parseDayParam(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

// A recurring occurrence's item.id is `CUSTOM:${eventId}:${occurrenceDay}`,
// not just `CUSTOM:${eventId}` (see calendar.ts's recurrence-expansion
// loop) -- recovering the real CalendarEvent id a mutating action needs
// requires stripping the prefix AND dropping any occurrence suffix. A
// non-recurring event's id has no second colon, so .split(":")[0] is a
// no-op for it and returns the same id .slice() alone would.
function baseCalendarEventId(itemId: string): string {
  return itemId.slice("CUSTOM:".length).split(":")[0];
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

// One week row: the day-cell grid (point-item pills, capped at 3 + "see
// more" link) plus the absolutely-positioned spanning-bar overlay.
// Reused by both month view (one call per row) and week view (exactly one
// call). monthStart is null in week view -- no day is ever dimmed as
// "other month" there, since a week can legitimately span two months.
function WeekRow({
  week,
  gridItems,
  pointItemsByDay,
  today,
  monthStart,
}: {
  week: Date[];
  gridItems: CalendarItem[];
  pointItemsByDay: Map<string, CalendarItem[]>;
  today: Date;
  monthStart: Date | null;
}) {
  const weekStart = week[0];
  const weekEnd = week[6];
  const segments = weekBarSegments(gridItems, weekStart, weekEnd);
  return (
    <div className="relative border-b border-neutral-100 last:border-b-0">
      <div className="grid grid-cols-7">
        {week.map((day) => {
          const key = utcDayKey(day);
          const points = pointItemsByDay.get(key) ?? [];
          const visible = points.slice(0, 3);
          const overflow = points.length - visible.length;
          const inCurrentMonth = monthStart === null || isSameUtcMonth(day, monthStart);
          return (
            <div
              key={key}
              className={`min-h-28 border-r border-neutral-100 p-1.5 last:border-r-0 ${inCurrentMonth ? "" : "bg-neutral-50/60"}`}
            >
              <Link
                href={`/calendar/day/${key}`}
                className={`mb-1 inline-flex text-xs font-medium ${
                  isSameUtcDay(day, today)
                    ? "h-5 w-5 items-center justify-center rounded-full bg-brand-black text-white"
                    : inCurrentMonth
                      ? "text-neutral-700 hover:underline"
                      : "text-neutral-400 hover:underline"
                }`}
              >
                {day.getUTCDate()}
              </Link>
              {segments.length > 0 && <div className="h-[1.15rem]" aria-hidden="true" />}
              <div className="flex flex-col gap-0.5">
                {visible.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className={`truncate rounded px-1 py-0.5 text-[11px] font-medium ${TONE_PILL[item.tone]} ${
                      isOverdueItem(item, today) ? "ring-1 ring-inset ring-red-500" : ""
                    }`}
                    title={isOverdueItem(item, today) ? `${item.title} (overdue)` : item.title}
                  >
                    {item.title}
                  </Link>
                ))}
                {overflow > 0 && (
                  <Link href={`/calendar/day/${key}`} className="px-1 text-[11px] text-neutral-400 hover:underline">
                    +{overflow} more
                  </Link>
                )}
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
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: "month" | "week"; date?: string; show?: string | string[]; feedUrl?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { view: rawView, date: dateParam, show, feedUrl } = await searchParams;
  const view: "month" | "week" = rawView === "week" ? "week" : "month";
  // Only fetch this when feedUrl is absent -- the one request that
  // redirected here with a fresh feedUrl already knows the answer.
  const hasFeed = feedUrl ? true : await hasActiveCalendarFeedToken(user.id);
  const today = utcToday();
  const parsedDate = dateParam ? parseDayParam(dateParam) : null;

  // shownGroups === null means "no `show` param at all" -- unfiltered.
  // A plain HTML checkbox-group GET form can't distinguish "submitted with
  // every box unchecked" from "never submitted" (both produce no `show`
  // key), so the filter form always includes one extra always-checked
  // hidden marker; its presence in the parsed array is what makes "show
  // nothing" a real, reachable state instead of silently falling back to
  // "show everything."
  const shownGroups: Set<string> | null =
    show === undefined ? null : new Set(([] as string[]).concat(show).filter((g) => g !== "__submitted__"));
  const showParams: string[] | undefined = shownGroups === null ? undefined : ["__submitted__", ...shownGroups];

  const monthStart = utcMonthStart(parsedDate ?? today);
  const monthEndDate = utcMonthEnd(monthStart);
  const weekStart = utcStartOfWeek(parsedDate ?? today);
  const weekEnd = utcEndOfWeek(weekStart);

  const gridStart = view === "week" ? weekStart : utcStartOfWeek(monthStart);
  const gridEnd = view === "week" ? weekEnd : utcEndOfWeek(monthEndDate);
  const days: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = utcAddDays(d, 1)) days.push(d);
  const weeks = chunkWeeks(days);

  const [rawGridItems, rawAgendaItems] = await Promise.all([
    getCalendarItems(user, gridStart, gridEnd),
    getUpcomingWithOverdue(user, today, AGENDA_WINDOW_DAYS),
  ]);
  const gridItems = rawGridItems.filter((item) => isGroupShown(item.type, shownGroups));
  const agendaItems = rawAgendaItems.filter((item) => isGroupShown(item.type, shownGroups));

  const pointItemsByDay = new Map<string, CalendarItem[]>();
  for (const item of gridItems) {
    if (item.dateEnd) continue;
    const key = utcDayKey(item.dateStart);
    const bucket = pointItemsByDay.get(key);
    if (bucket) bucket.push(item);
    else pointItemsByDay.set(key, [item]);
  }

  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";

  const qs = (overrides: { view?: "month" | "week"; date?: string }): string => {
    const sp = new URLSearchParams();
    const v = overrides.view ?? view;
    if (v !== "month") sp.set("view", v);
    if (overrides.date) sp.set("date", overrides.date);
    if (showParams !== undefined) for (const g of showParams) sp.append("show", g);
    const s = sp.toString();
    return s ? `/calendar?${s}` : "/calendar";
  };

  const prevDate = view === "week" ? fmtDayParam(utcAddDays(weekStart, -7)) : fmtDayParam(utcAddMonths(monthStart, -1));
  const nextDate = view === "week" ? fmtDayParam(utcAddDays(weekStart, 7)) : fmtDayParam(utcAddMonths(monthStart, 1));
  const title = view === "week" ? `Week of ${fmtDay(weekStart)}` : fmtMonthTitle(monthStart);

  return (
    <div>
      <PageHeader
        title={title}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href={qs({ view: "month" })} className={view === "month" ? TAB_ACTIVE : TAB_INACTIVE}>
              Month
            </Link>
            <Link href={qs({ view: "week" })} className={view === "week" ? TAB_ACTIVE : TAB_INACTIVE}>
              Week
            </Link>
            <Link href={qs({ date: prevDate })} className={NAV_LINK_CLASS}>
              ← Prev
            </Link>
            <Link href={qs({})} className={NAV_LINK_CLASS}>
              Today
            </Link>
            <Link href={qs({ date: nextDate })} className={NAV_LINK_CLASS}>
              Next →
            </Link>
            <form method="get" className="flex items-center gap-1">
              {view !== "month" && <input type="hidden" name="view" value={view} />}
              {showParams !== undefined && showParams.map((g) => <input key={g} type="hidden" name="show" value={g} />)}
              <input
                type="date"
                name="date"
                defaultValue={dateParam ?? fmtDayParam(today)}
                aria-label="Jump to date"
                className="rounded-md border border-neutral-300 bg-white px-2 py-[5px] text-sm text-neutral-700"
              />
              <button type="submit" className={NAV_LINK_CLASS}>
                Go
              </button>
            </form>
          </div>
        }
      />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-50 text-center text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="py-2">
                {d}
              </div>
            ))}
          </div>
          {weeks.map((week, wi) => (
            <WeekRow
              key={wi}
              week={week}
              gridItems={gridItems}
              pointItemsByDay={pointItemsByDay}
              today={today}
              monthStart={view === "month" ? monthStart : null}
            />
          ))}
        </Card>

        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Show</h2>
            <form method="get" className="flex flex-col gap-2">
              {view !== "month" && <input type="hidden" name="view" value={view} />}
              {dateParam && <input type="hidden" name="date" value={dateParam} />}
              <input type="hidden" name="show" value="__submitted__" />
              {Object.entries(CALENDAR_FILTER_GROUPS).map(([key, group]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-neutral-700">
                  <input
                    type="checkbox"
                    name="show"
                    value={key}
                    defaultChecked={shownGroups === null || shownGroups.has(key)}
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                  {group.label}
                </label>
              ))}
              <Button variant="secondary" type="submit">
                Apply
              </Button>
            </form>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Next {AGENDA_WINDOW_DAYS} days
            </h2>
            {agendaItems.length === 0 ? (
              <p className="text-sm text-neutral-400">Nothing coming up.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {agendaItems.map((item) => {
                  const overdue = isOverdueItem(item, today);
                  return (
                  <li key={item.id} className="flex items-start justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <Link href={item.href} className="link-underline block truncate font-medium text-neutral-900">
                        {item.title}
                      </Link>
                      <div className="text-xs text-neutral-500">
                        {CALENDAR_ITEM_TYPE_LABELS[item.type]} ·{" "}
                        {overdue ? (
                          <span className="rounded-full bg-red-50 px-1.5 py-0.5 font-medium text-red-700">
                            Overdue — {fmtDay(item.dateStart)}
                          </span>
                        ) : (
                          <>
                            {fmtDay(item.dateStart)}
                            {item.dateEnd ? `–${fmtDay(item.dateEnd)}` : ""}
                          </>
                        )}
                      </div>
                    </div>
                    {item.type === "CUSTOM" && (item.ownerId === user.id || isAdmin) && (
                      <form action={deleteCalendarEventAction.bind(null, baseCalendarEventId(item.id))}>
                        <button type="submit" aria-label="Delete" className="text-neutral-400 hover:text-red-600">
                          ✕
                        </button>
                      </form>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Subscribe</h2>
            {feedUrl ? (
              <CopyLinkBanner
                link={feedUrl}
                message="Calendar feed link — copy this into your calendar app (Google Calendar, Apple Calendar, Outlook) now. It won't be shown again after you leave this page; use Regenerate below if you lose it."
              />
            ) : (
              <>
                <p className="mb-3 text-sm text-neutral-500">
                  Get a personal link you can subscribe to from any calendar app — it stays in sync automatically.
                </p>
                <form action={issueCalendarFeedTokenAction}>
                  <Button variant="secondary">{hasFeed ? "Regenerate feed link" : "Get subscribe link"}</Button>
                </form>
              </>
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
              <SelectField
                label="Repeats"
                name="recurrence"
                defaultValue="NONE"
                options={[
                  { value: "NONE", label: "Doesn't repeat" },
                  { value: "WEEKLY", label: "Weekly" },
                  { value: "MONTHLY", label: "Monthly" },
                ]}
              />
              <SubmitButton variant="primary" pendingText="Adding…">
                Add to calendar
              </SubmitButton>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
