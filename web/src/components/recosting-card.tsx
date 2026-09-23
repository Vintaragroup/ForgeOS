import Link from "next/link";
import { Card } from "@/components/ui";
import { DocumentDiffSummary } from "@/components/document-diff-summary";
import { recostingNextStep, type RecostingState } from "@/lib/recosting";
import type { DocumentDiff } from "@/lib/document-diff";

// The whole of "the client wants a lower number" in one place.
//
// It used to be four manual actions across two pages -- upload, set the
// type, pick what it replaces from a list of every document, click
// Analyze -- with the answer rendering on the Opportunity while the line
// items it was about lived on the Estimate. Nothing said what to do
// next, and nothing said when a step had silently done nothing.
//
// So this shows one step at a time, and never more than one. The state
// is decided in recosting.ts; this only renders it.

function Step({ n, done, children }: { n: number; done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
          done ? "bg-green-100 text-green-800" : "bg-neutral-200 text-neutral-600"
        }`}
        aria-hidden="true"
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </li>
  );
}

export function RecostingCard({
  state,
  diff,
  estimateId,
  opportunityId,
}: {
  state: RecostingState;
  // Only meaningful in READY. Passed in rather than computed here so this
  // stays free of db access.
  diff: DocumentDiff | null;
  estimateId: string;
  opportunityId: string;
}) {
  if (state.kind === "NONE") return null;

  const nextStep = recostingNextStep(state);
  const hasDocument = state.kind !== "AWAITING_DOCUMENT";
  const readable = state.kind === "READY";
  // A revised schedule is imported, not analysed, and its comparison is
  // scope rather than money -- both of which happen on the import
  // preview, where the workbook is already being parsed.
  const importable = state.kind === "READY_TO_IMPORT";
  const importHref =
    state.kind === "READY_TO_IMPORT"
      ? `/estimates/${estimateId}?tab=documents&importDocumentId=${state.document.id}`
      : null;

  return (
    <Card className="border-amber-200 bg-amber-50/40 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-900">
        Re-costing version {state.versionNumber}
      </h2>

      {/* The client's own words, first. This is the reason every step
          below exists, and it is the thing people come back to the page
          to re-read. */}
      {state.request?.note && (
        <blockquote className="mt-2 border-l-2 border-amber-300 pl-3 text-sm text-neutral-700">
          “{state.request.note}”
          <span className="ml-2 text-xs text-neutral-500">
            asked {state.request.at.toLocaleDateString()}
          </span>
        </blockquote>
      )}

      <p className="mt-3 text-sm font-medium text-neutral-900">{nextStep}</p>

      <ol className="mt-4 flex flex-col gap-3">
        <Step n={1} done={hasDocument}>
          {state.kind !== "AWAITING_DOCUMENT" ? (
            <>
              <span className="font-medium text-neutral-900">{state.document.filename}</span>
              {state.document.supersedesFilename && (
                <span className="text-neutral-500"> replaces {state.document.supersedesFilename}</span>
              )}
            </>
          ) : (
            <>
              <span className="text-neutral-700">Upload the revised pricing on the opportunity, </span>
              <Link
                href={`/opportunities/${opportunityId}#documents`}
                className="font-medium text-brand-navy hover:underline"
              >
                in Documents
              </Link>
              <span className="text-neutral-700">
                , and set what it replaces — that link is what gets it read and compared.
              </span>
            </>
          )}
        </Step>

        <Step n={2} done={readable || importable}>
          {importHref ? (
            <>
              <Link href={importHref} className="font-medium text-brand-navy hover:underline">
                See what changed and import →
              </Link>
              {/* Said plainly rather than left to be discovered: a
                  schedule carries no prices for ForgeOS to read, so the
                  money question is answered by the re-priced total, not
                  by the sheet. */}
              <p className="mt-1 text-xs text-neutral-500">
                Shows what the client dropped, added and re-counted. A schedule carries no prices — the new cost
                comes from the catalog when you import, and lands in version {state.versionNumber}.
              </p>
            </>
          ) : state.kind === "READY" && state.document.supersedesFilename ? (
            <DocumentDiffSummary
              predecessorFilename={state.document.supersedesFilename}
              extracted
              diff={diff}
            />
          ) : state.kind === "AWAITING_ANALYSIS" ? (
            <span className="text-neutral-600">
              Being read now. Nothing can be compared until it finishes — reload in a moment.
            </span>
          ) : state.kind === "ANALYSIS_FAILED" ? (
            <span className="text-red-700">
              {state.document.filename} couldn&apos;t be read, so there is nothing to compare. Re-upload it as a
              PDF or spreadsheet export, or compare it by hand.
            </span>
          ) : (
            <span className="text-neutral-500">What changed — dropped lines, repriced lines, the net movement.</span>
          )}
        </Step>

        <Step n={3} done={false}>
          {importable ? (
            <span className="text-neutral-600">
              Check version {state.versionNumber}&apos;s new total against what the client asked for.
            </span>
          ) : readable ? (
            <Link
              href={`/estimates/${estimateId}?tab=documents`}
              className="font-medium text-brand-navy hover:underline"
            >
              Apply it to version {state.versionNumber} →
            </Link>
          ) : (
            <span className="text-neutral-500">Apply the new pricing to version {state.versionNumber}.</span>
          )}
        </Step>
      </ol>
    </Card>
  );
}
