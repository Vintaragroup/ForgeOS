import type { DocumentDiff } from "@/lib/document-diff";

// What a revised document changes against the one it replaces.
//
// The answer a person is chasing is usually one number -- "did they get
// to $850k?" -- so the net movement leads, and the rows explain it.
//
// Removals come first and are the loudest thing here. They are the half
// de-duplication could never see: a line the vendor quietly dropped was
// simply never proposed, so nothing noticed it was gone.

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function signedMoney(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;
}

export function DocumentDiffSummary({
  predecessorFilename,
  extracted,
  diff,
  pricedViaImport = false,
}: {
  predecessorFilename: string;
  // False when the document has not been analyzed yet. "No changes" would
  // be a confident lie about a document nobody has read.
  extracted: boolean;
  diff: DocumentDiff | null;
  // A spreadsheet is never analyzed -- it is parsed on demand at import,
  // and nothing is stored on the document. Telling its reader to
  // "analyze it" names an action that does not exist for this row: the
  // same row says "Priced via import" and offers only "Import on
  // Estimate page". Which is exactly what it used to say.
  pricedViaImport?: boolean;
}) {
  if (!extracted || !diff) {
    return (
      <p className="mt-1 text-xs text-neutral-500">
        Replaces {predecessorFilename}.{" "}
        {pricedViaImport
          ? "Import it on the estimate to see what changed."
          : "Analyze it to see what changed."}
      </p>
    );
  }

  if (diff.rows.length === 0) {
    return (
      <p className="mt-1 text-xs text-neutral-500">
        Replaces {predecessorFilename} — nothing priced differently.
      </p>
    );
  }

  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-neutral-600">
        Replaces {predecessorFilename} —{" "}
        <span className={diff.netDelta < 0 ? "font-semibold text-green-700" : "font-semibold text-amber-800"}>
          {signedMoney(diff.netDelta)}
        </span>{" "}
        <span className="text-neutral-400">
          ({diff.removedCount} dropped · {diff.changedCount} repriced · {diff.addedCount} added)
        </span>
      </summary>
      <ul className="mt-2 flex flex-col gap-1 border-l-2 border-neutral-200 pl-3">
        {diff.rows.map((row, i) => (
          <li key={`${row.description}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="min-w-0">
              <span
                className={`mr-1.5 rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${
                  row.kind === "REMOVED"
                    ? "bg-red-100 text-red-800"
                    : row.kind === "ADDED"
                      ? "bg-blue-100 text-blue-800"
                      : "bg-amber-100 text-amber-900"
                }`}
              >
                {row.kind === "REMOVED" ? "dropped" : row.kind === "ADDED" ? "added" : "repriced"}
              </span>
              <span className="text-neutral-700">{row.description}</span>
              {/* Which thing moved. A halved quantity is a different
                  conversation from a halved price. */}
              {row.kind === "CHANGED" && row.previous && row.current && (
                <span className="ml-1 text-neutral-400">
                  {row.unitCostChanged && `${money(row.previous.unitCost)} → ${money(row.current.unitCost)}`}
                  {row.unitCostChanged && row.qtyChanged && " · "}
                  {row.qtyChanged && `qty ${row.previous.qty} → ${row.current.qty}`}
                </span>
              )}
            </span>
            <span className={`shrink-0 tabular-nums ${row.delta < 0 ? "text-green-700" : "text-amber-800"}`}>
              {signedMoney(row.delta)}
            </span>
          </li>
        ))}
      </ul>
      {diff.removedCount > 0 && (
        <p className="mt-2 text-[11px] leading-snug text-neutral-500">
          A dropped line may mean the vendor removed it, or just that it isn&apos;t in this quote. Check before
          taking it out of the estimate.
        </p>
      )}
    </details>
  );
}
