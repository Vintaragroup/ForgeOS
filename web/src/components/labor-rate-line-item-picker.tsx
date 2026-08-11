"use client";

import { useState } from "react";
import { Field, SelectField } from "@/components/ui";

export interface LaborRateOption {
  id: string;
  label: string;
  department: string | null;
  rate: number;
}

// Sixth client component (see document-upload-form.tsx's header comment
// on the fourth, project-type-fields.tsx on the fifth). Picking a
// catalogued rate here autofills Category/Dept/Unit cost below -- all
// three stay freely editable afterward, this just saves the estimator a
// trip to the Labor Rates catalog page to copy a number over by hand.
// The picker's own <select> submits too (name="_laborRatePicker") but
// addLineItemAction ignores unrecognized form fields, so that's harmless.
export function LaborRateLineItemFields({
  categoryOptions,
  laborRates,
  defaultCategory = "",
  defaultDepartment = "",
  defaultUnitCost = "",
}: {
  categoryOptions: { value: string; label: string }[];
  laborRates: LaborRateOption[];
  // Prefill for editing an existing line item -- blank (Add Line Item's
  // default) for a brand new one.
  defaultCategory?: string;
  defaultDepartment?: string;
  defaultUnitCost?: string;
}) {
  const [category, setCategory] = useState(defaultCategory);
  const [department, setDepartment] = useState(defaultDepartment);
  const [unitCost, setUnitCost] = useState(defaultUnitCost);

  function handlePick(id: string) {
    const picked = laborRates.find((r) => r.id === id);
    if (!picked) return;
    setCategory("Labor");
    setDepartment(picked.department ?? "");
    setUnitCost(String(picked.rate));
  }

  return (
    <>
      {laborRates.length > 0 && (
        <div className="col-span-2 sm:order-0 sm:w-64">
          <SelectField
            label="Labor rate"
            name="_laborRatePicker"
            defaultValue=""
            options={[
              { value: "", label: "— pick to autofill Dept/Category/Unit cost —" },
              ...laborRates.map((r) => ({ value: r.id, label: r.label })),
            ]}
            onChange={handlePick}
          />
        </div>
      )}
      <div className="sm:order-3 sm:w-24">
        <Field label="Dept" name="department" value={department} onChange={setDepartment} placeholder="EF" />
      </div>
      <div className="sm:order-4 sm:w-40">
        <SelectField label="Category" name="category" value={category} onChange={setCategory} options={categoryOptions} />
      </div>
      <div className="sm:order-7 sm:w-28">
        <Field label="Unit cost ($)" name="unitCost" type="number" value={unitCost} onChange={setUnitCost} required />
      </div>
    </>
  );
}
