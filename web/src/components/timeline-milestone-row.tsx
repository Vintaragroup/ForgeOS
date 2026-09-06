"use client";

import { useState } from "react";
import { StatusChip } from "@/components/ui";

// "EXPO_CC" is only the internal Prisma enum value -- the real company
// name/abbreviation (per brand.ts's BRAND_COMPANY_NAME and the historical
// EXPO_CCI_*.xlsx files this app already reads) is "Expo CCI", not "Expo
// CC". Confirmed live: production rendered the abbreviation with the
// trailing "I" dropped.
const RESPONSIBLE_PARTY_OPTIONS: { value: string; label: string }[] = [
  { value: "CLIENT", label: "Client" },
  { value: "EXPO_CC", label: "Expo CCI" },
];

// One row in the Opportunity page's Timeline card -- same Empty/Editing
// state-machine shape as this app's other inline editors
// (InternalCostRow, SectionHeadingEditor), plus a status chip reflecting
// where the current value came from (or that it's still missing).
export function TimelineMilestoneRow({
  label,
  displayDate,
  rawDate,
  responsibleParty,
  source,
  confirmed,
  citationHref,
  citationLabel,
  conflictDisplayDate,
  conflictCitationHref,
  conflictCitationLabel,
  updateAction,
}: {
  label: string;
  // Formatted for display (e.g. "Dec 7, 2026"), or null if unset.
  displayDate: string | null;
  // yyyy-mm-dd for the edit form's date input, or "" if unset.
  rawDate: string;
  responsibleParty: string;
  source: "DETERMINISTIC" | "COMPUTED" | "AI_SUGGESTED" | "MANUAL";
  confirmed: boolean;
  citationHref: string | null;
  citationLabel: string | null;
  // Set only when this row's date comes from a confirmed Opportunity field
  // that disagrees with what a scope document actually states -- see
  // timeline-service.ts's TimelineMilestone.conflict. null/undefined means
  // no known disagreement.
  conflictDisplayDate?: string | null;
  conflictCitationHref?: string | null;
  conflictCitationLabel?: string | null;
  updateAction: (formData: FormData) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);

  const statusChip = !displayDate ? (
    <StatusChip tone="critical">Missing</StatusChip>
  ) : conflictDisplayDate ? (
    <StatusChip tone="warning">Differs from source</StatusChip>
  ) : !confirmed ? (
    <StatusChip tone="warning">{source === "COMPUTED" ? "Computed — review" : "AI-suggested — review"}</StatusChip>
  ) : (
    <StatusChip tone="good">Confirmed</StatusChip>
  );

  if (isEditing) {
    return (
      <tr className="border-b border-neutral-100 bg-neutral-50">
        <td className="py-2 pr-2 text-sm font-medium">{label}</td>
        <td colSpan={3} className="py-2">
          <form
            action={async (formData) => {
              await updateAction(formData);
              setIsEditing(false);
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <input
              name="date"
              type="date"
              defaultValue={rawDate}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            />
            <select
              name="responsibleParty"
              defaultValue={responsibleParty}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              {RESPONSIBLE_PARTY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded bg-brand-navy px-3 py-1 text-sm font-medium text-white hover:bg-brand-navy/90"
            >
              Save
            </button>
            <button type="button" onClick={() => setIsEditing(false)} className="text-xs text-neutral-400 hover:underline">
              Cancel
            </button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-neutral-100">
      <td className="py-1.5 pr-2 text-sm font-medium">{label}</td>
      <td className="py-1.5 pr-2 text-sm">
        {displayDate ?? "—"}
        {citationHref && (
          <a href={citationHref} className="ml-2 text-xs text-brand-navy hover:underline">
            {citationLabel}
          </a>
        )}
        {conflictDisplayDate && (
          <div className="mt-0.5 text-xs text-amber-600">
            ⚠ Document says {conflictDisplayDate}
            {conflictCitationHref && (
              <a href={conflictCitationHref} className="ml-1 text-brand-navy hover:underline">
                {conflictCitationLabel}
              </a>
            )}
          </div>
        )}
      </td>
      <td className="py-1.5 pr-2 text-sm text-neutral-500">
        {RESPONSIBLE_PARTY_OPTIONS.find((o) => o.value === responsibleParty)?.label ?? responsibleParty}
      </td>
      <td className="py-1.5 pl-2 text-right whitespace-nowrap">
        {statusChip}
        <button
          type="button"
          onClick={() => setIsEditing(true)}
          className="ml-3 text-xs text-neutral-500 hover:text-neutral-900"
        >
          Edit
        </button>
      </td>
    </tr>
  );
}
