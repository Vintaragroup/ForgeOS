import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCalendarItems, isOverdueItem, utcAddDays, utcToday, CALENDAR_ITEM_TYPE_LABELS, type CalendarItem, type CalendarItemTone } from "@/lib/calendar";
import { PageHeader, Card, Field, SelectField, Button } from "@/components/ui";
import { createCalendarEventAction, updateCalendarEventAction, deleteCalendarEventAction } from "../../actions";

export const dynamic = "force-dynamic";

// Same tone-pill palette as the month/week grid (calendar/page.tsx) --
// duplicated rather than imported, matching this feature's existing
// per-file constant-duplication convention (isAdmin, TONE_*).
const TONE_PILL: Record<CalendarItemTone, string> = {
  neutral: "bg-neutral-100 text-neutral-600",
  info: "bg-brand-navy/10 text-brand-navy",
  warning: "bg-brand-tan text-amber-900",
  good: "bg-brand-teal-pale text-teal-800",
  critical: "bg-red-50 text-red-700",
};

const RECURRENCE_OPTIONS = [
  { value: "NONE", label: "Doesn't repeat" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
];

function parseDayParam(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

function fmtDayTitle(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// A recurring occurrence's item.id is `CUSTOM:${eventId}:${occurrenceDay}`,
// not just `CUSTOM:${eventId}` -- recovering the real CalendarEvent id a
// mutating action needs requires stripping the prefix AND dropping any
// occurrence suffix. A non-recurring event's id has no second colon, so
// this is a no-op for it.
function baseCalendarEventId(itemId: string): string {
  return itemId.slice("CUSTOM:".length).split(":")[0];
}

export default async function CalendarDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { date: dateParam } = await params;
  const dayStart = parseDayParam(dateParam);
  if (!dayStart) notFound();

  const { edit: editId } = await searchParams;
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  const today = utcToday();

  const items = await getCalendarItems(user, dayStart, dayStart);

  const prevDate = dayKey(utcAddDays(dayStart, -1));
  const nextDate = dayKey(utcAddDays(dayStart, 1));
  const todayKey = dayKey(today);

  // The item currently being edited, if any -- must actually be a CUSTOM
  // item on this day owned by the viewer (or admin), matching the same
  // owner-or-admin gate updateCalendarEventAction itself enforces
  // server-side; this is only the UI-level "should we even show the
  // form" check.
  const editingItem = editId
    ? items.find((i) => i.type === "CUSTOM" && baseCalendarEventId(i.id) === editId && (i.ownerId === user.id || isAdmin))
    : undefined;

  // CalendarItem (the aggregated shape getCalendarItems returns) doesn't
  // carry visibility/recurrence -- those only exist on the real
  // CalendarEvent row, so pre-filling the edit form with the note's
  // actual current values needs this one extra direct fetch, only when
  // actually editing.
  const editingEvent = editingItem
    ? await db.calendarEvent.findUnique({ where: { id: editId }, select: { visibility: true, recurrence: true } })
    : null;

  return (
    <div>
      <PageHeader
        title={fmtDayTitle(dayStart)}
        action={
          <div className="flex items-center gap-2">
            <Link href={`/calendar/day/${prevDate}`} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              ← Prev day
            </Link>
            <Link href={`/calendar/day/${todayKey}`} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              Today
            </Link>
            <Link href={`/calendar/day/${nextDate}`} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              Next day →
            </Link>
          </div>
        }
      />

      <div className="flex max-w-2xl flex-col gap-6">
        <Card className="p-4">
          {items.length === 0 ? (
            <p className="text-sm text-neutral-400">Nothing on this day.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => {
                const overdue = isOverdueItem(item, today);
                const canManage = item.type === "CUSTOM" && (item.ownerId === user.id || isAdmin);
                const rawEventId = item.type === "CUSTOM" ? baseCalendarEventId(item.id) : null;

                if (editingItem && item.id === editingItem.id && rawEventId && editingEvent) {
                  return (
                    <li key={item.id}>
                      <EditNoteForm eventId={rawEventId} item={item} event={editingEvent} dayKeyStr={dateParam} />
                    </li>
                  );
                }

                return (
                  <li key={item.id} className="flex items-start justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE_PILL[item.tone]}`}>
                        {CALENDAR_ITEM_TYPE_LABELS[item.type]}
                      </span>
                      <Link href={item.href} className="font-medium text-neutral-900 hover:underline">
                        {item.title}
                      </Link>
                      {overdue && (
                        <span className="ml-2 rounded-full bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">Overdue</span>
                      )}
                    </div>
                    {canManage && rawEventId && (
                      <div className="flex shrink-0 items-center gap-3">
                        <Link href={`/calendar/day/${dateParam}?edit=${rawEventId}`} className="text-xs text-brand-navy hover:underline">
                          Edit
                        </Link>
                        <form action={deleteCalendarEventAction.bind(null, rawEventId)}>
                          <button type="submit" aria-label="Delete" className="text-neutral-400 hover:text-red-600">
                            ✕
                          </button>
                        </form>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Add a note</h2>
          <form action={createCalendarEventAction} className="flex flex-col gap-3">
            <Field label="Title" name="title" required />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date" name="date" type="date" required defaultValue={dateParam} />
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
            <SelectField label="Repeats" name="recurrence" defaultValue="NONE" options={RECURRENCE_OPTIONS} />
            <Button>Add to calendar</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function EditNoteForm({
  eventId,
  item,
  event,
  dayKeyStr,
}: {
  eventId: string;
  item: CalendarItem;
  event: { visibility: string; recurrence: string };
  dayKeyStr: string;
}) {
  const updateWithId = updateCalendarEventAction.bind(null, eventId);
  return (
    <Card className="border-brand-navy/30 bg-brand-navy/5 p-4">
      <form action={updateWithId} className="flex flex-col gap-3">
        <Field label="Title" name="title" required defaultValue={item.title} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" name="date" type="date" required defaultValue={dayKey(item.dateStart)} />
          <Field label="End date (optional)" name="dateEnd" type="date" defaultValue={item.dateEnd ? dayKey(item.dateEnd) : undefined} />
        </div>
        <SelectField
          label="Visibility"
          name="visibility"
          defaultValue={event.visibility}
          options={[
            { value: "PRIVATE", label: "Just me" },
            { value: "ORG", label: "Everyone" },
          ]}
        />
        <SelectField label="Repeats" name="recurrence" defaultValue={event.recurrence} options={RECURRENCE_OPTIONS} />
        <div className="flex items-center gap-2">
          <Button>Save changes</Button>
          <Link href={`/calendar/day/${dayKeyStr}`} className="text-sm text-neutral-500 hover:underline">
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}
