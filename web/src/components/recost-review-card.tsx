import type { RecostReview } from "@/lib/recost-review";
import type { CorroborationKind } from "@/lib/recost-corroboration";
import { rollupHeadline } from "@/lib/recost-rollup";
import { RunRecostProposalsButton } from "@/components/run-recost-proposals-button";
import { RecostProposalDecision } from "@/components/recost-proposal-decision";
import { ProposeFromBreakoutButton } from "@/components/propose-from-breakout-button";
import { AcceptRecommendedButton } from "@/components/accept-recommended-button";

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

// Named for what the reader has to do about it, not for what the model
// reported. "Removed" says nothing about whether anyone has acted on it;
// "still priced" says the money is in the estimate right now.
const LABELS: Record<CorroborationKind, { text: string; className: string }> = {
  STILL_PRICED: { text: "still priced", className: "bg-red-100 text-red-800" },
  ADDED_NOT_PRICED: { text: "not priced", className: "bg-amber-100 text-amber-900" },
  DRAWN_NOT_PRICED: { text: "check", className: "bg-neutral-200 text-neutral-700" },
  CORROBORATED: { text: "confirmed", className: "bg-green-100 text-green-800" },
};

export function RecostReviewCard({ review, estimateId }: { review: RecostReview | null; estimateId: string }) {
  if (!review) return null;
  const { rollup } = review;
  // Nothing priced, nothing at risk, and no drawing compared is a review
  // with no content -- the steps card above is already saying what to do
  // about that. A drawing on its own is still worth the screen.
  if (rollup.lines.length === 0 && !review.drawing?.findings.length) return null;

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

      {/* The deterministic half, at the resolution an estimator works
          at. The rollup above says an element moved; this says which
          rows moved and by how much, which is what actually has to
          change in the open version. */}
      {review.lineItemDiff && review.lineItemDiff.elements.length > 0 && (
        <div className="mt-5 border-t border-neutral-200 pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">What needs updating in this version</h3>
            <ProposeFromBreakoutButton estimateId={estimateId} />
          </div>
          <p className="mt-1 text-sm text-neutral-600">
            {review.lineItemDiff.changedRows} rows re-costed, {review.lineItemDiff.removedRows} removed
            {review.lineItemDiff.addedRows > 0 ? `, ${review.lineItemDiff.addedRows} added` : ""} — read from the
            two workbooks, not inferred.
          </p>

          {/* Two reads of one pair of files that disagree is a fact, not
              a number to pick between. */}
          {review.lineItemDiff.disagreesWithSummaryBy !== null && (
            <p className="mt-1 text-xs text-amber-800">
              This differs from the estimator&apos;s own Summary column by{" "}
              {money(Math.abs(review.lineItemDiff.disagreesWithSummaryBy))}. Worth checking which is current.
            </p>
          )}

          <div className="mt-3 flex flex-col gap-4">
            {review.lineItemDiff.elements.map((element) => (
              <div key={element.tab}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-neutral-900">
                    {element.tab}
                    {element.elementRemoved && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-800">
                        element removed
                      </span>
                    )}
                  </span>
                  <span className="text-xs tabular-nums text-neutral-600">
                    {money(element.previousTotal)} → {money(element.currentTotal)}
                  </span>
                </div>

                {/* The estimator renamed the element, which is where a
                    spec decision like "NON LIT" lives and the only place
                    it is recorded. */}
                {element.titleChanged && (
                  <p className="mt-0.5 text-xs text-neutral-500">
                    renamed: “{element.previousTitle}” → “{element.currentTitle}”
                  </p>
                )}

                <ul className="mt-1 flex flex-col gap-0.5">
                  {element.changes.slice(0, 8).map((c, i) => (
                    <li key={`${c.description}-${i}`} className="flex gap-2 text-xs text-neutral-600">
                      <span className="w-16 shrink-0 text-neutral-400">{c.kind.toLowerCase()}</span>
                      <span className="min-w-0 flex-1">
                        {c.description}
                        {c.variant && <span className="text-neutral-400"> ({c.variant})</span>}
                        <span className="text-neutral-400">
                          {" · "}qty {c.previousQty ?? "—"} → {c.currentQty ?? "—"}
                          {c.previousUnitCost !== c.currentUnitCost &&
                            ` · unit ${money(c.previousUnitCost ?? 0)} → ${money(c.currentUnitCost ?? 0)}`}
                        </span>
                      </span>
                      {c.costDelta !== null && (
                        <span className="shrink-0 tabular-nums text-neutral-700">{signedMoney(c.costDelta)}</span>
                      )}
                    </li>
                  ))}
                  {element.changes.length > 8 && (
                    <li className="text-xs text-neutral-400">… {element.changes.length - 8} more</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The second witness. Kept below the money because it does not
          change any of it -- nothing here has been priced, which is
          exactly the point of showing it. */}
      {review.drawing && review.drawing.findings.length > 0 && (
        <div className="mt-5 border-t border-neutral-200 pt-4">
          <h3 className="text-sm font-semibold text-neutral-900">What the revised drawing shows</h3>
          <p className="mt-1 text-sm text-neutral-600">{review.drawing.headline}</p>

          <ul className="mt-3 flex flex-col gap-2">
            {review.drawing.findings.map((f) => (
              <li key={`${f.kind}-${f.subject}`} className="flex gap-3 text-sm">
                <span
                  className={`mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${LABELS[f.kind].className}`}
                >
                  {LABELS[f.kind].text}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-neutral-900">{f.subject}</span>
                  {f.element && <span className="text-neutral-500"> — {f.element}</span>}
                  {/* The drawing's own words, not a paraphrase: a
                      finding is checkable or it is gossip. */}
                  <span className="block text-xs text-neutral-500">
                    {f.detail}
                    {f.pages && <span className="text-neutral-400"> ({f.pages})</span>}
                  </span>
                </div>
                {f.amount !== null && f.amount > 0 && (
                  <span className="shrink-0 whitespace-nowrap tabular-nums text-neutral-700">{money(f.amount)}</span>
                )}
              </li>
            ))}
          </ul>

          {review.drawing.charactersMismatched && (
            <p className="mt-3 text-xs text-amber-800">
              {review.drawing.previousFilename} and {review.drawing.revisedFilename} are different kinds of drawing —
              one dimensioned, one a rendering. The same object drawn two ways can read as removed and added, so
              treat these as worth checking rather than as settled.
            </p>
          )}
        </div>
      )}

      {/* The one AI stage, and everything about it is opt-in: it costs a
          model call, and nothing on this screen changes until a person
          decides. Every row below already survived validation against
          real ids and a verbatim quote — see recost-proposal.ts. */}
      {(review.proposals.length > 0 ||
        (review.drawing && review.drawing.findings.some((f) => f.kind !== "CORROBORATED"))) && (
        <div className="mt-5 border-t border-neutral-200 pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">Waiting on your decision</h3>
            {review.recommended.count > 0 && (
              <AcceptRecommendedButton
                estimateId={estimateId}
                count={review.recommended.count}
                costDelta={review.recommended.costDelta}
              />
            )}
            {/* Only offered when there is something for a model to map.
                The workbook proposals above need no model at all. */}
            {review.drawing && review.drawing.findings.some((f) => f.kind !== "CORROBORATED") && (
              <RunRecostProposalsButton
                estimateId={estimateId}
                hasProposals={review.proposals.length > 0}
              />
            )}
          </div>

          {/* Said next to the button rather than discovered after it. */}
          {review.recommended.count > 0 && review.recommended.count < review.proposals.length && (
            <p className="mt-1 text-xs text-neutral-500">
              That applies the {review.recommended.count} re-costs read from the revised workbook. The other{" "}
              {review.proposals.length - review.recommended.count} — removals, and anything read off a drawing —
              stay one decision at a time.
            </p>
          )}

          {review.proposals.length === 0 ? (
            <p className="mt-1 text-sm text-neutral-500">
              Nothing mapped yet. The findings above are in the drawing&apos;s words; this works out which rows of
              the estimate they are about, and proposes nothing you have not confirmed.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {review.proposals.map((p) => (
                <li key={p.id} className="rounded-md border border-neutral-200 p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                      {p.action.replace("_", " ")}
                    </span>
                    <span className="font-medium text-neutral-900">{p.target}</span>
                    {p.amount !== null && (
                      <span className="ml-auto whitespace-nowrap tabular-nums text-neutral-700">
                        {money(p.amount)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-neutral-700">{p.reason}</p>
                  {/* The citation, verbatim, with the document it came
                      from. A proposal that cannot be checked against its
                      own source has no business being acted on. */}
                  <p className="mt-1 text-xs text-neutral-500">
                    “{p.sourceQuote}” — {p.sourceFilename}
                  </p>
                  <p className="mt-1 text-xs font-medium text-amber-800">
                    {p.confidence === "NEED_YOUR_DECISION" ? "Needs your decision" : "Recommended — confirm"}
                  </p>
                  <RecostProposalDecision
                    estimateId={estimateId}
                    proposalId={p.id}
                    effect={p.effect}
                    movesMoney={p.movesMoney}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Why, with the citation it was decided against. The line-item
          history below records what changed and offers Restore; this
          records the decision behind it. Neither is complete alone. */}
      {review.decided.length > 0 && (
        <div className="mt-5 border-t border-neutral-200 pt-4">
          <h3 className="text-sm font-semibold text-neutral-900">Already decided</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {review.decided.map((d) => (
              <li key={d.id} className="text-sm">
                <span
                  className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    d.status === "REJECTED"
                      ? "bg-neutral-200 text-neutral-700"
                      : d.status === "APPLIED"
                        ? "bg-red-100 text-red-800"
                        : "bg-green-100 text-green-800"
                  }`}
                >
                  {d.status.toLowerCase()}
                </span>
                <span className="font-medium text-neutral-900">{d.action.replace("_", " ")}</span>
                <span className="text-neutral-700"> — {d.target}</span>
                <span className="block text-xs text-neutral-500">
                  {d.reason} · “{d.sourceQuote}”
                </span>
                <span className="block text-xs text-neutral-400">
                  {d.decidedBy}
                  {d.decidedAt ? ` · ${d.decidedAt.toLocaleDateString()}` : ""}
                  {d.status === "APPLIED" ? " · restore it from the line-item history below" : ""}
                </span>
              </li>
            ))}
          </ul>
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
