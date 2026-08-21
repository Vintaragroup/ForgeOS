"use client";

import { useState, type ReactNode } from "react";
import { SelectField } from "@/components/ui";

// Lets a category tab's empty-state "Add line item" form target a specific
// section when an estimate has more than one -- without this, the first
// item added to a previously-empty category silently attached to
// version.sections[0] no matter which section the user actually meant,
// with no indication a choice had even been made. Each section's form is
// pre-rendered server-side (its server action is already bound to that
// section's id -- see CategoryTabContent), and stays mounted rather than
// swapped out on selection change, same reasoning as Tabs: switching the
// picker shouldn't silently discard whatever the user already typed into
// a different section's form.
export function SectionScopedForm({
  sections,
  content,
}: {
  sections: { id: string; name: string }[];
  content: Record<string, ReactNode>;
}) {
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? "");

  return (
    <div className="flex flex-col gap-3">
      <div className="w-64">
        <SelectField
          label="Section"
          name="sectionId"
          value={sectionId}
          onChange={setSectionId}
          options={sections.map((s) => ({ value: s.id, label: s.name }))}
        />
      </div>
      {sections.map((s) => (
        <div key={s.id} hidden={s.id !== sectionId}>
          {content[s.id]}
        </div>
      ))}
    </div>
  );
}
