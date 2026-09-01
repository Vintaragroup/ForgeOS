"use client";

import { useState } from "react";
import { Field, ReadOnlyField, SelectField } from "@/components/ui";

// Seventh client component (see document-upload-form.tsx's header comment
// on the fourth, project-type-fields.tsx on the fifth, labor-rate-line-
// item-picker.tsx on the sixth). No new math or schema needed here --
// LineItem.totalCost is already qty * unitCost regardless of what `unit`
// says (business-rules.md Rules 1-2), so "square feet x cost per sq ft"
// already computes correctly the moment `qty` holds the square footage
// and `unit` says "SQFT". This component exists purely so an estimator
// doesn't have to know that and remember to type "SQFT" by hand -- it
// relabels Qty to "Square feet" and locks Unit to SQFT for them. The
// picker's own <select> submits too (name="_qtyMode") but
// addLineItemAction/updateLineItemAction ignore unrecognized form fields,
// same as the labor-rate picker's own _laborRatePicker field.
const QTY_MODE_OPTIONS = [
  { value: "qty", label: "Quantity" },
  { value: "sqft", label: "Square feet" },
];

export function QuantityOrAreaFields({
  defaultQty = "1",
  defaultUnit = "",
}: {
  defaultQty?: string;
  defaultUnit?: string;
}) {
  const [mode, setMode] = useState<"qty" | "sqft">(defaultUnit.trim().toUpperCase() === "SQFT" ? "sqft" : "qty");
  const [unit, setUnit] = useState(defaultUnit);

  // Slots 5/6/7 -- fills the gap between LaborRateLineItemFields' own
  // Category (order-4) and Unit Cost (order-8, bumped up one to make room
  // here); Usage/isClientOwned/etc. downstream are bumped the same +1.
  return (
    <>
      <div className="sm:order-5 sm:w-32">
        <SelectField
          label="Pricing basis"
          name="_qtyMode"
          value={mode}
          onChange={(value) => {
            const next = value as "qty" | "sqft";
            setMode(next);
            if (next === "sqft") setUnit("SQFT");
          }}
          options={QTY_MODE_OPTIONS}
        />
      </div>
      <div className="sm:order-6 sm:w-24">
        <Field label={mode === "sqft" ? "Square feet" : "Qty"} name="qty" type="number" defaultValue={defaultQty} required />
      </div>
      <div className="sm:order-7 sm:w-24">
        {mode === "sqft" ? (
          <>
            <ReadOnlyField label="Unit" value="SQFT" />
            <input type="hidden" name="unit" value="SQFT" />
          </>
        ) : (
          <Field label="Unit" name="unit" value={unit} onChange={setUnit} placeholder="EA, SQFT, LF" />
        )}
      </div>
    </>
  );
}
