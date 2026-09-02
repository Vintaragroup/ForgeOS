"use client";

import { useActionState } from "react";
import { Field, SelectField } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { addSectionAction, type AddSectionResult } from "@/app/(app)/estimates/actions";

const SECTION_TYPE_OPTIONS = [
  { value: "COMPONENT", label: "Component" },
  { value: "CATEGORY", label: "Category" },
  { value: "FEE", label: "Fee" },
];

// Client component specifically so useActionState can hand the just-
// created section's name/group straight back to render a confirmation
// here, without a redirect -- see addSectionAction's own comment for why
// a redirect-based confirmation (this file's first version) froze the
// browser tab on a real, large estimate. revalidatePath inside the
// action still refreshes the page's server data in place (e.g. so this
// new section shows up in "Add first item to an empty section" below),
// exactly like every other plain-form action on this page already does.
export function AddSectionForm({
  estimateId,
  versionId,
  existingGroupLabels,
}: {
  estimateId: string;
  versionId: string;
  existingGroupLabels: string[];
}) {
  const [result, formAction] = useActionState<AddSectionResult | null, FormData>(
    (prevState, formData) => addSectionAction(estimateId, versionId, prevState, formData),
    null,
  );

  return (
    <details className="group/add-section mb-6">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-full border border-dashed border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 marker:content-none [&::-webkit-details-marker]:hidden">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Add section
      </summary>
      {result && (
        <p className="mt-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
          Created section &quot;{result.name}&quot;{result.groupLabel ? ` in group "${result.groupLabel}"` : ""}.
          It&apos;s empty, so it won&apos;t appear under any category tab until it has at least one line item -- use
          the &quot;Add first item to an empty section&quot; control in any category tab below (or ask chat) to add
          one.
        </p>
      )}
      <form action={formAction} className="mt-3 flex items-end gap-3">
        <div className="flex-1">
          <Field label="New section name" name="name" placeholder="e.g. COMPONENT 1" required />
        </div>
        <div className="flex-1">
          {/* Free text, not a fixed picker: typing an existing group
              reuses it (a new H2 inside that H1); typing anything else
              creates a brand-new, independent group (a new H1) -- the
              datalist only ever suggests, it never constrains. Blank
              means project-wide, no group at all. */}
          <Field
            label="Group (optional)"
            name="groupLabel"
            placeholder="e.g. FS - Reception Counter -- blank for project-wide"
            list="existing-group-labels"
          />
          <datalist id="existing-group-labels">
            {existingGroupLabels.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
        </div>
        <div className="w-48">
          <SelectField label="Type" name="sectionType" defaultValue="COMPONENT" options={SECTION_TYPE_OPTIONS} />
        </div>
        <SubmitButton variant="secondary" pendingText="Adding...">
          Add section
        </SubmitButton>
      </form>
    </details>
  );
}
