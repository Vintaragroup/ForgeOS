"use client";

import { useEffect, useRef, useState } from "react";
import { formatOpportunityLabel } from "@/lib/opportunity-name";

// Lives inside the same <form> as the Company select, Show name field,
// and ProjectTypeFields' own booth number + event start date inputs --
// without lifting any of those into controlled state here (which would
// mean duplicating ProjectTypeFields' own projectType-conditional
// rendering, or restructuring a component the edit form also reuses
// unchanged). Instead this watches the surrounding form's current,
// uncontrolled values directly via a native input/change listener, the
// same "watch the DOM, don't own the state" split ProjectTypeFields'
// own header comment describes for projectType. Renders wherever a new
// or existing opportunity's identifying fields are entered -- see
// opportunity-name.ts's own comment for why the estimator asked for
// this convention in the first place.
export function OpportunityNamePreview({ companies }: { companies: { id: string; name: string }[] }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState("");

  useEffect(() => {
    const form = anchorRef.current?.closest("form");
    if (!form) return;

    function update() {
      const data = new FormData(form as HTMLFormElement);
      const companyId = String(data.get("companyId") ?? "");
      const companyName = companies.find((c) => c.id === companyId)?.name ?? "";
      setLabel(
        formatOpportunityLabel({
          companyName,
          showName: String(data.get("showName") ?? ""),
          eventStartDate: String(data.get("eventStartDate") ?? "") || null,
          boothNumber: String(data.get("boothNumber") ?? ""),
        }),
      );
    }

    update();
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
    };
  }, [companies]);

  return (
    <div
      ref={anchorRef}
      className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-600"
    >
      <span className="font-medium text-neutral-500">This opportunity will be identified as: </span>
      {label ? (
        <span className="font-medium text-neutral-900">{label}</span>
      ) : (
        <span className="italic text-neutral-400">Client Name @ Show Name Year – Booth # (if known)</span>
      )}
    </div>
  );
}
