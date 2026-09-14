import Link from "next/link";

// A plain CSS horizontal-bar list -- not SVG, not a charting library
// (nothing like this exists anywhere else in the app yet, and it should
// stay consistent with the rest of the app's server-rendered/minimal-
// client-JS posture). Each row is itself a link -- these exist to be a
// navigation surface into a filtered view, not just a static summary, so
// every row doubles as a "jump to this slice of the data" shortcut.
export interface BarBreakdownRow {
  label: string;
  count: number;
  href: string;
}

export function BarBreakdown({
  title,
  rows,
  emptyMessage,
}: {
  title: string;
  rows: BarBreakdownRow[];
  emptyMessage?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-400">{emptyMessage ?? "No data."}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.label}>
              <Link
                href={row.href}
                className="relative flex items-center justify-between overflow-hidden rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm hover:border-neutral-400"
              >
                {/* Bar fill sits behind the text via z-index stacking, not
                    layout -- the label/count are always fully readable
                    regardless of bar length, even at the shortest bars. */}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-brand-teal-pale"
                  style={{ width: `${Math.max((row.count / max) * 100, 4)}%` }}
                />
                <span className="relative truncate pr-2 font-medium text-neutral-800">{row.label}</span>
                <span className="relative shrink-0 tabular-nums text-neutral-500">{row.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
