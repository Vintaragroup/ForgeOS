"use client";

import { useState } from "react";
import { Field, SelectField } from "@/components/ui";

export interface CutListLineItemOption {
  id: string;
  label: string;
  description: string;
}

// Cut-list phase 6: CutListPart.lineItemId already existed in the schema
// (Phase 0) but nothing ever set it -- every part was typed from scratch
// even when it was fabrication detail for a line the estimator already
// described and priced. Picking a line item here prefills Description
// (still freely editable after) and submits the real lineItemId for
// addCutListPartAction to persist -- unlike
// labor-rate-line-item-picker.tsx's picker, whose own <select> is
// deliberately throwaway (only used to autofill sibling fields), this
// one's value IS the field the server action reads.
export function CutListPartFields({ lineItems }: { lineItems: CutListLineItemOption[] }) {
  const [description, setDescription] = useState("");

  function handlePick(id: string) {
    const picked = lineItems.find((li) => li.id === id);
    if (picked) setDescription(picked.description);
  }

  return (
    <>
      {lineItems.length > 0 && (
        <div className="col-span-2 sm:order-0 sm:w-64">
          <SelectField
            label="Link to line item (optional)"
            name="lineItemId"
            defaultValue=""
            options={[{ value: "", label: "— None (standalone part) —" }, ...lineItems.map((li) => ({ value: li.id, label: li.label }))]}
            onChange={handlePick}
          />
        </div>
      )}
      <div className="col-span-2 sm:order-1 sm:flex-1 sm:min-w-[10rem]">
        <Field label="Description" name="description" value={description} onChange={setDescription} required />
      </div>
    </>
  );
}
