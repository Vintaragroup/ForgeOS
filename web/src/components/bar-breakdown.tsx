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
  // Omit for a row with no real drill-down target (e.g. the Analytics
  // view's revision-rounds/existing-vs-new splits, which have no matching
  // Production Log filter to jump to) -- rendered as a plain non-clickable
  // row rather than a Link to somewhere that wouldn't actually filter
  // anything.
  href?: string;
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
          {rows.map((row) => {
            const barFill = (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-brand-teal-pale"
                style={{ width: `${Math.max((row.count / max) * 100, 4)}%` }}
              />
            );
            const inner = (
              <>
                {barFill}
                <span className="relative truncate pr-2 font-medium text-neutral-800">{row.label}</span>
                <span className="relative shrink-0 tabular-nums text-neutral-500">{row.count}</span>
              </>
            );
            return (
              <li key={row.label}>
                {row.href ? (
                  <Link
                    href={row.href}
                    className="relative flex items-center justify-between overflow-hidden rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm hover:border-neutral-400"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="relative flex items-center justify-between overflow-hidden rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm">
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
