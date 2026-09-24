import type { ScopeDiff } from "@/lib/scope-diff";

// What a revised schedule drops, adds and re-counts, shown where the
// decision to commit it gets made.
//
// Import can only add: it reports how many rows are new and how many
// duplicate something already here, and says nothing at all about what
// is no longer on the sheet. On a job being cut to a budget that is the
// half that matters -- a line the client removed was simply never
// re-proposed, so nothing noticed it was gone.
//
// No money here on purpose. A pricing schedule carries no prices (see
// scope-diff.ts); the new cost arrives when the catalog re-prices these
// rows at import. Showing a dollar figure would be inventing one.

function qty(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function ScopeDiffSummary({
  predecessorFilename,
  diff,
}: {
  predecessorFilename: string;
  diff: ScopeDiff;
}) {
  if (diff.rows.length === 0) {
    return (
      <p className="mb-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
        Same scope as {predecessorFilename} — nothing dropped, added or re-counted.
      </p>
    );
  }

  // 142 rows on a real revision, so the list is closed by default and
  // capped. The counts in the summary are the finding; the rows are the
  // evidence, and evidence does not need to be on screen until asked
  // for.
  const VISIBLE = 25;
  const shown = diff.rows.slice(0, VISIBLE);
  const hidden = diff.rows.length - shown.length;

  return (
    <details className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
      <summary className="cursor-pointer text-sm text-amber-900">
        Against {predecessorFilename}:{" "}
        <span className="font-semibold">{diff.removedCount} dropped</span> ·{" "}
        {diff.qtyChangedCount} re-counted · {diff.addedCount} added
        {diff.unchangedCount > 0 && (
          <span className="text-amber-700"> · {diff.unchangedCount} unchanged</span>
        )}
      </summary>

      <ul className="mt-2 flex flex-col gap-1 border-l-2 border-amber-300 pl-3 text-sm">
        {shown.map((row, i) => (
          <li key={`${row.description}-${i}`} className="flex flex-wrap items-baseline gap-2">
            <span
              className={`rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${
                row.kind === "REMOVED"
                  ? "bg-red-100 text-red-800"
                  : row.kind === "ADDED"
                    ? "bg-blue-100 text-blue-800"
                    : "bg-amber-100 text-amber-900"
              }`}
            >
              {row.kind === "REMOVED" ? "dropped" : row.kind === "ADDED" ? "added" : "re-counted"}
            </span>
            <span className="min-w-0 text-neutral-800">{row.description}</span>
            {row.kind === "QTY_CHANGED" && (
              <span className="tabular-nums text-neutral-500">
                {qty(row.previousQty ?? 0)} → {qty(row.currentQty ?? 0)}
                {row.unit ? ` ${row.unit}` : ""}
              </span>
            )}
            {row.kind === "REMOVED" && (
              <span className="tabular-nums text-neutral-500">
                was {qty(row.previousQty ?? 0)}
                {row.unit ? ` ${row.unit}` : ""}
              </span>
            )}
          </li>
        ))}
      </ul>

      {hidden > 0 && (
        <p className="mt-2 text-xs text-neutral-500">
          + {hidden} more, smallest movements last. Open the sheet for the full list.
        </p>
      )}

      {/* The distinction that keeps this from reading as an instruction.
          Import adds; it cannot remove. A dropped row is a question for
          the estimator, not something committing this import will do. */}
      {diff.removedCount > 0 && (
        <p className="mt-2 text-xs leading-snug text-amber-900">
          Committing this import will <strong>not</strong> remove anything. A dropped row means the revised sheet no
          longer carries it — check whether the client cut it, or whether it simply lives in another document, before
          taking it out of the estimate.
        </p>
      )}
    </details>
  );
}
