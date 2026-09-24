import type { RecostReview } from "@/lib/recost-review";
import { rollupHeadline } from "@/lib/recost-rollup";

// Where the re-cost stands against the client's number.
//
// The RecostingCard above this one answers "what do I do next". This one
// answers the question that actually gets asked in the room: are we
// there yet. They are deliberately separate cards -- the steps stop
// mattering once they are done, and this does not.
//
// Gap-led on purpose. On Full Swing the priced changes take about
// $100,000 off a $658,785 estimate against a $250,000 target, and a
// screen that leads with "saved $100,000" reads as progress toward a
// goal it has not approached. So the headline is the shortfall, and the
// saving is the arithmetic underneath it. See recost-rollup.ts.

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function signedMoney(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n))}`;
}

export function RecostReviewCard({ review }: { review: RecostReview | null }) {
  if (!review) return null;
  const { rollup } = review;
  // Nothing priced and nothing at risk is a review with no content --
  // the steps card above is already saying what to do about that.
  if (rollup.lines.length === 0) return null;

  const over = rollup.gap !== null && rollup.gap > 0;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Re-cost review — version {review.versionNumber}
        </h2>
        {rollup.target !== null && (
          <span className="text-xs text-neutral-500">target {money(rollup.target)}</span>
        )}
      </div>

      <p className={`mt-3 text-lg font-semibold ${over ? "text-red-700" : "text-green-800"}`}>
        {rollupHeadline(rollup)}
      </p>

      <table className="mt-4 w-full text-sm">
        <tbody>
          {rollup.lines.map((line) => (
            <tr key={line.label} className="border-t border-neutral-100 align-top">
              <td className="py-2 pr-4">
                <span className="font-medium text-neutral-900">{line.label}</span>
                <span className="block text-xs text-neutral-500">{line.detail}</span>
              </td>
              <td className="py-2 text-right whitespace-nowrap tabular-nums">
                {line.costDelta !== null ? (
                  <span className={line.costDelta < 0 ? "text-green-800" : "text-neutral-900"}>
                    {signedMoney(line.costDelta)}
                  </span>
                ) : line.costAtRisk !== null ? (
                  // Said as a question rather than as a number in the
                  // savings column, because that is what it is. Whatever
                  // replaces it has not been priced.
                  <span className="text-amber-800">{money(line.costAtRisk)} unpriced</span>
                ) : (
                  <span className="text-neutral-400">—</span>
                )}
              </td>
            </tr>
          ))}

          <tr className="border-t-2 border-neutral-300">
            <td className="py-2 pr-4 font-medium text-neutral-900">
              Projected sell
              <span className="block text-xs text-neutral-500">
                {money(rollup.currentSell)} today, with the priced changes applied at this estimate&apos;s own{" "}
                {rollup.sellPerCost.toFixed(2)}× cost-to-sell.
              </span>
            </td>
            <td className="py-2 text-right whitespace-nowrap font-semibold tabular-nums">
              {money(rollup.projectedSell)}
            </td>
          </tr>

          {rollup.gap !== null && (
            <tr>
              <td className="py-2 pr-4 font-medium text-neutral-900">
                {over ? "Still over by" : "Under target by"}
              </td>
              <td
                className={`py-2 text-right whitespace-nowrap font-semibold tabular-nums ${
                  over ? "text-red-700" : "text-green-800"
                }`}
              >
                {money(Math.abs(rollup.gap))}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Only ever a prompt to look. These are untouched because an
          estimator decided not to touch them, and that decision deserves
          revisiting rather than overriding. */}
      {review.suggestions.length > 0 && (
        <div className="mt-5 rounded-md border border-neutral-200 bg-neutral-50 p-4">
          <p className="text-sm font-medium text-neutral-900">
            The biggest things nobody has re-costed yet
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {review.suggestions.map((s) => (
              <li key={s.label} className="flex justify-between gap-4">
                <span className="text-neutral-700">{s.label}</span>
                <span className="whitespace-nowrap tabular-nums text-neutral-900">{money(s.cost)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            Marked as no change on the revised schedule. Named here because the gap is still open, not because
            anything says they should move.
          </p>
        </div>
      )}

      {review.notes.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 text-xs text-neutral-500">
          {review.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
