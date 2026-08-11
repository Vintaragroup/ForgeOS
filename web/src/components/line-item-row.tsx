"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Field, SelectField } from "@/components/ui";
import { LaborRateLineItemFields, type LaborRateOption } from "@/components/labor-rate-line-item-picker";

// Seventh client component (see document-upload-form.tsx's header
// comment on the fourth, project-type-fields.tsx on the fifth,
// labor-rate-line-item-picker.tsx on the sixth). Toggles a table row
// between its normal read-only rendering and a full edit form -- the
// only field previously editable on an already-added line item was
// unitCost, and only for a draft row (see updateLineItemUnitCostAction).
// This covers every field, on any unlocked-version row, so a
// mis-categorized or manually-priced item doesn't have to be deleted and
// re-added just to fix it.
export function LineItemRow({
  description,
  isDraft,
  sourceHref,
  department,
  lineType,
  category,
  qty,
  unit,
  unitCost,
  totalCostDisplay,
  isClientOwned,
  isLocked,
  actualCostDisplay,
  varianceDisplay,
  varianceTone,
  lineTypeOptions,
  categoryOptions,
  laborRates,
  deleteAction,
  confirmAction,
  updateAction,
}: {
  description: string;
  isDraft: boolean;
  sourceHref: string | null;
  department: string;
  lineType: string;
  category: string;
  qty: string;
  unit: string;
  unitCost: string;
  totalCostDisplay: string;
  isClientOwned: boolean;
  isLocked: boolean;
  actualCostDisplay: string | null;
  varianceDisplay: string | null;
  varianceTone: "up" | "down" | "flat" | null;
  lineTypeOptions: { value: string; label: string }[];
  categoryOptions: { value: string; label: string }[];
  laborRates: LaborRateOption[];
  deleteAction: (formData: FormData) => void | Promise<void>;
  confirmAction: (formData: FormData) => void | Promise<void>;
  updateAction: (formData: FormData) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <tr className="border-t border-neutral-100 bg-neutral-50">
        <td colSpan={7} className="py-2">
          <form
            action={async (formData) => {
              await updateAction(formData);
              setIsEditing(false);
            }}
            className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end"
          >
            <div className="col-span-2 sm:order-2 sm:flex-1 sm:min-w-[10rem]">
              <Field label="Description" name="description" defaultValue={description} required />
            </div>
            <div className="sm:order-1 sm:w-36">
              <SelectField label="Type" name="lineType" defaultValue={lineType} options={lineTypeOptions} />
            </div>
            <LaborRateLineItemFields
              categoryOptions={categoryOptions}
              laborRates={laborRates}
              defaultCategory={category}
              defaultDepartment={department}
              defaultUnitCost={unitCost}
            />
            <div className="sm:order-5 sm:w-24">
              <Field label="Qty" name="qty" type="number" defaultValue={qty} required />
            </div>
            <div className="sm:order-6 sm:w-24">
              <Field label="Unit" name="unit" defaultValue={unit} placeholder="EA, SQFT, LF" />
            </div>
            <label className="col-span-2 flex items-center gap-1.5 pb-2 text-sm text-neutral-700 sm:order-8 sm:col-span-1">
              <input type="checkbox" name="isClientOwned" defaultChecked={isClientOwned} />
              Client owned (no charge)
            </label>
            <div className="flex gap-3 sm:order-9">
              <Button variant="secondary">Save</Button>
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="text-xs text-neutral-500 hover:underline"
              >
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-neutral-100">
      <td className="py-1.5">
        {description}
        {isDraft && (
          <span className="ml-2 rounded-full bg-brand-tan px-2 py-0.5 text-xs text-amber-900">draft</span>
        )}
        {sourceHref && (
          <Link href={sourceHref} className="ml-2 text-xs text-brand-navy hover:underline" title="Verify against source">
            source →
          </Link>
        )}
      </td>
      <td className="py-1.5">{department}</td>
      <td className="py-1.5">{lineType}</td>
      <td className="py-1.5 text-right">
        {qty}
        {unit && <span className="ml-1 text-neutral-400">{unit}</span>}
      </td>
      <td className="py-1.5 text-right">${Number(unitCost).toFixed(2)}</td>
      <td className="py-1.5 text-right">{totalCostDisplay}</td>
      {isLocked && actualCostDisplay !== null && varianceDisplay !== null && (
        <>
          <td className="py-1.5 text-right">{actualCostDisplay}</td>
          <td
            className={`py-1.5 text-right ${
              varianceTone === "up" ? "text-red-600" : varianceTone === "down" ? "text-green-600" : ""
            }`}
          >
            {varianceTone === "up" ? "+" : ""}
            {varianceDisplay}
          </td>
        </>
      )}
      {!isLocked && (
        <td className="py-1.5 text-right whitespace-nowrap">
          <button onClick={() => setIsEditing(true)} className="mr-2 text-xs text-neutral-700 hover:underline">
            edit
          </button>
          {isDraft && (
            <form action={confirmAction} className="inline">
              <button className="mr-2 text-xs text-neutral-700 hover:underline">confirm</button>
            </form>
          )}
          <form action={deleteAction} className="inline">
            <button className="text-xs text-red-500 hover:underline">remove</button>
          </form>
        </td>
      )}
    </tr>
  );
}
