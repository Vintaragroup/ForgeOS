"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Field, SelectField } from "@/components/ui";
import { LaborRateLineItemFields, type LaborRateOption } from "@/components/labor-rate-line-item-picker";
import { QuantityOrAreaFields } from "@/components/quantity-or-area-fields";
import { useBidPackageSelection } from "@/components/bid-package-selection";

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
  id,
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
  usageTag,
  isLocked,
  actualCostDisplay,
  varianceDisplay,
  varianceTone,
  isFirst,
  isLast,
  lineTypeOptions,
  usageTagOptions,
  categoryOptions,
  laborRates,
  bidPackageName,
  positionCode,
  deleteAction,
  confirmAction,
  updateAction,
  moveUpAction,
  moveDownAction,
}: {
  id: string;
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
  // Manual disambiguation for a genuinely ambiguous material (PVC, for
  // one) -- "" means unset, same convention as category/department above.
  usageTag: string;
  isLocked: boolean;
  actualCostDisplay: string | null;
  varianceDisplay: string | null;
  varianceTone: "up" | "down" | "flat" | null;
  isFirst: boolean;
  isLast: boolean;
  lineTypeOptions: { value: string; label: string }[];
  usageTagOptions: { value: string; label: string }[];
  categoryOptions: { value: string; label: string }[];
  laborRates: LaborRateOption[];
  // Null = in-house/undecided (BidPackage.name once assigned) -- see
  // bid-package-selection.tsx's header comment for why this row renders
  // a selection checkbox instead whenever it's null AND a
  // BidPackageSelectionProvider is wrapping this table (a no-op render
  // everywhere else, including every existing caller that predates this
  // prop).
  bidPackageName?: string | null;
  // The vendor/RFP position code (e.g. "CAM-17") this row was imported
  // with, if any -- see LineItem.positionCode's own schema comment.
  // Otherwise invisible anywhere in this tab, even though it's the one
  // thing that can distinguish two rows sharing an identical generic
  // description/qty/price (a real case: two symmetric booth platforms of
  // the same size legitimately cost the same).
  positionCode?: string | null;
  deleteAction: (formData: FormData) => void | Promise<void>;
  confirmAction: (formData: FormData) => void | Promise<void>;
  updateAction: (formData: FormData) => void | Promise<void>;
  moveUpAction: (formData: FormData) => void | Promise<void>;
  moveDownAction: (formData: FormData) => void | Promise<void>;
}) {
  const selection = useBidPackageSelection();
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <tr id={`line-item-${id}`} className="border-t border-neutral-100 bg-neutral-50">
        <td colSpan={7} className="px-2 py-2">
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
            <QuantityOrAreaFields defaultQty={qty} defaultUnit={unit} />
            <div className="sm:order-9 sm:w-36">
              <SelectField label="Usage" name="usageTag" defaultValue={usageTag} options={usageTagOptions} />
            </div>
            <label className="col-span-2 flex items-center gap-1.5 pb-2 text-sm text-neutral-700 sm:order-10 sm:col-span-1">
              <input type="checkbox" name="isClientOwned" defaultChecked={isClientOwned} />
              Client owned (no charge)
            </label>
            <div className="flex gap-3 sm:order-11">
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
    <tr id={`line-item-${id}`} className="border-t border-neutral-100">
      <td className="px-2 py-1.5">
        {selection && !isLocked && !bidPackageName && (
          <input
            type="checkbox"
            className="mr-2 align-middle"
            checked={selection.selectedIds.has(id)}
            onChange={() => selection.toggle(id)}
            aria-label="Select this line item (for a bid package or a bulk category move)"
          />
        )}
        {positionCode && (
          <span className="mr-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">{positionCode}</span>
        )}
        {description}
        {isDraft && (
          <span className="ml-2 rounded-full bg-brand-tan px-2 py-0.5 text-xs text-amber-900">draft</span>
        )}
        {usageTag && (
          <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
            {usageTagOptions.find((o) => o.value === usageTag)?.label ?? usageTag}
          </span>
        )}
        {bidPackageName && (
          <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">
            In package: {bidPackageName}
          </span>
        )}
        {sourceHref && (
          <Link href={sourceHref} className="ml-2 text-xs text-brand-navy hover:underline" title="Verify against source">
            source →
          </Link>
        )}
      </td>
      <td className="px-2 py-1.5">{department}</td>
      <td className="px-2 py-1.5">{lineType}</td>
      <td className="px-2 py-1.5 text-right">
        {qty}
        {unit && <span className="ml-1 text-neutral-400">{unit}</span>}
      </td>
      <td className="px-2 py-1.5 text-right">${Number(unitCost).toFixed(2)}</td>
      <td className="px-2 py-1.5 text-right">{totalCostDisplay}</td>
      {isLocked && actualCostDisplay !== null && varianceDisplay !== null && (
        <>
          <td className="px-2 py-1.5 text-right">{actualCostDisplay}</td>
          <td
            className={`px-2 py-1.5 text-right ${
              varianceTone === "up" ? "text-red-600" : varianceTone === "down" ? "text-green-600" : ""
            }`}
          >
            {varianceTone === "up" ? "+" : ""}
            {varianceDisplay}
          </td>
        </>
      )}
      {!isLocked && (
        <td className="px-2 py-1.5">
          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
            <form action={moveUpAction} className="inline">
              <button
                disabled={isFirst}
                className="text-xs text-neutral-400 hover:text-neutral-700 disabled:opacity-30 disabled:hover:text-neutral-400"
                title="Move up"
              >
                ▲
              </button>
            </form>
            <form action={moveDownAction} className="inline">
              <button
                disabled={isLast}
                className="text-xs text-neutral-400 hover:text-neutral-700 disabled:opacity-30 disabled:hover:text-neutral-400"
                title="Move down"
              >
                ▼
              </button>
            </form>
            <button
              onClick={() => setIsEditing(true)}
              className="text-sm text-neutral-400 hover:text-neutral-700"
              title="Edit"
              aria-label="Edit line item"
            >
              ✎
            </button>
            {isDraft && (
              <form action={confirmAction} className="inline">
                <button
                  className="text-sm text-neutral-400 hover:text-green-600"
                  title="Confirm"
                  aria-label="Confirm draft line item"
                >
                  ✓
                </button>
              </form>
            )}
            <form action={deleteAction} className="inline">
              <button className="text-sm text-neutral-400 hover:text-red-600" title="Remove" aria-label="Remove line item">
                ✕
              </button>
            </form>
          </div>
        </td>
      )}
    </tr>
  );
}
