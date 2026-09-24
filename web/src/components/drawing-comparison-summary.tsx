"use client";

import { ActionForm } from "@/components/action-form";
import { compareDrawingRevisionAction } from "@/app/(app)/opportunities/[id]/documents/actions";
import type { DrawingComparison } from "@/lib/ai/drawing-comparison-service";

// What the revised design changed, on the document row where the two
// drawings are already linked.
//
// This is the only source that speaks in booths. A schedule diff on the
// same job reports 42 dropped rows called "30% CNC op" and "building
// supplies" -- true, and useless for answering "what did the client
// cut". A rendering can say "reception counter".

const KIND_LABEL: Record<DrawingComparison["findings"][number]["kind"], string> = {
  REMOVED: "removed",
  ADDED: "added",
  CHANGED: "changed",
};

const KIND_TONE: Record<DrawingComparison["findings"][number]["kind"], string> = {
  REMOVED: "bg-red-100 text-red-800",
  ADDED: "bg-blue-100 text-blue-800",
  CHANGED: "bg-amber-100 text-amber-900",
};

export function DrawingComparisonSummary({
  opportunityId,
  documentId,
  predecessorFilename,
  comparison,
}: {
  opportunityId: string;
  documentId: string;
  predecessorFilename: string;
  comparison: DrawingComparison | null;
}) {
  if (!comparison) {
    return (
      <ActionForm
        action={compareDrawingRevisionAction.bind(null, opportunityId, documentId)}
        className="mt-1 flex flex-wrap items-center gap-2 text-xs"
      >
        <span className="text-neutral-500">Replaces {predecessorFilename}.</span>
        <button type="submit" className="font-medium text-brand-navy hover:underline">
          Compare the designs →
        </button>
      </ActionForm>
    );
  }

  if (comparison.findings.length === 0) {
    return (
      <p className="mt-1 text-xs text-neutral-500">
        Compared against {predecessorFilename} — nothing visibly different across{" "}
        {comparison.previousPagesCompared} and {comparison.revisedPagesCompared} pages.
      </p>
    );
  }

  const removed = comparison.findings.filter((f) => f.kind === "REMOVED").length;
  const changed = comparison.findings.filter((f) => f.kind === "CHANGED").length;
  const added = comparison.findings.filter((f) => f.kind === "ADDED").length;

  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-neutral-600">
        Against {predecessorFilename}:{" "}
        <span className="font-semibold text-neutral-900">
          {removed} removed · {changed} changed · {added} added
        </span>
      </summary>

      <ul className="mt-2 flex flex-col gap-1.5 border-l-2 border-neutral-200 pl-3">
        {comparison.findings.map((f, i) => (
          <li key={`${f.subject}-${i}`}>
            <span
              className={`mr-1.5 rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${KIND_TONE[f.kind]}`}
            >
              {KIND_LABEL[f.kind]}
            </span>
            <span className="font-medium text-neutral-900">{f.subject}</span>
            <span className="text-neutral-600"> — {f.detail}</span>
            {/* Which sheet it is visible on, so the finding can be
                checked rather than believed. */}
            <span className="ml-1 text-neutral-400">
              {f.previousPage !== null && `was p${f.previousPage}`}
              {f.previousPage !== null && f.revisedPage !== null && " · "}
              {f.revisedPage !== null && `now p${f.revisedPage}`}
            </span>
          </li>
        ))}
      </ul>

      {/* Two things this cannot do, said rather than left to be
          discovered -- both are rules from the estimating guidelines
          (§10, §11, §15) that the prompt refuses to break. */}
      <p className="mt-2 text-[11px] leading-snug text-neutral-500">
        Read from the renderings only. It reports what is visibly different and never a dimension, material or
        component that isn&apos;t printed on the sheet — so a changed screen doesn&apos;t imply a mount, and a
        shorter sign doesn&apos;t come with a size. Nothing here changes the estimate.
      </p>
    </details>
  );
}
