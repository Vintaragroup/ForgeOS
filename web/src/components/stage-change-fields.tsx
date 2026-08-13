"use client";

import { useState } from "react";
import { Field, SelectField } from "@/components/ui";

export const STAGE_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "CONTACTED", label: "Contacted" },
  { value: "QUALIFIED", label: "Qualified" },
  { value: "ESTIMATING", label: "Estimating" },
  { value: "WON", label: "Won" },
  { value: "LOST", label: "Lost" },
];

// Neutral factor names, not "lost to..." framing -- CloseReason is one
// enum shared by both outcomes (see schema.prisma's own comment), since
// most of these are the same underlying fact with a different sign
// (won on price vs. lost on price is still "price" as the reason).
export const CLOSE_REASON_OPTIONS = [
  { value: "", label: "— select a reason —" },
  { value: "PRICE", label: "Price" },
  { value: "TIMELINE", label: "Timeline / schedule" },
  { value: "SCOPE_FIT", label: "Scope / requirements fit" },
  { value: "COMPETITOR", label: "Competitor" },
  { value: "BUDGET_CANCELLED", label: "Budget cut / project cancelled" },
  { value: "NO_RESPONSE", label: "No response / went dark" },
  { value: "RELATIONSHIP", label: "Relationship / trust" },
  { value: "OTHER", label: "Other" },
];

export const CLOSE_REASON_LABELS = Object.fromEntries(
  CLOSE_REASON_OPTIONS.filter((o) => o.value).map((o) => [o.value, o.label]),
) as Record<string, string>;

// Reveals Close reason fields only once the selected target stage is
// WON or LOST -- the one piece of context that's impossible to
// reconstruct after the fact once everyone's moved on from a closed
// deal, so it's worth asking right at the moment of the transition
// rather than as a separate step nobody revisits. The underlying
// <form>/Button are still the parent's (opportunities/[id]/page.tsx),
// same division of labor as ProjectTypeFields.
export function StageChangeFields({ defaultStage }: { defaultStage: string }) {
  const [stage, setStage] = useState(defaultStage);
  const isClosing = stage === "WON" || stage === "LOST";

  return (
    <>
      <SelectField
        // Forces React to remount this uncontrolled select whenever the
        // server-side stage changes -- otherwise the DOM node is reused
        // across the Server Action's re-render and keeps showing the
        // pre-submit value until a hard navigation.
        key={defaultStage}
        label="Move to"
        name="stage"
        defaultValue={defaultStage}
        options={STAGE_OPTIONS}
        onChange={setStage}
      />
      <div className="flex-1 min-w-[10rem]">
        <Field label="Note (optional)" name="note" />
      </div>
      {isClosing && (
        <>
          <SelectField label="Reason" name="closeReason" options={CLOSE_REASON_OPTIONS} />
          <div className="flex-1 min-w-[10rem]">
            <Field label="Detail (optional)" name="closeReasonDetail" />
          </div>
        </>
      )}
    </>
  );
}
