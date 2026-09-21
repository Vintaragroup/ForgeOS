"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import type { ActionResult } from "@/lib/user-error";

// Where a piece gets produced, edited as a set.
//
// Three independent choices rather than one dropdown, because they really
// are independent: a piece can be printed in-house AND at an outside shop
// (50 of 282 rows on the Seatrade show are), each half finishing on its
// own schedule.
//
// Offices are passed in already filtered to those with a sign shop, so
// this cannot offer an option the service would reject.

export interface RoutingEditorOffice {
  code: string;
  name: string;
}
export interface RoutingEditorVendor {
  id: string;
  name: string;
}
export interface CurrentRouting {
  kind: "EXPO_IN_HOUSE" | "VENDOR" | "AM_PM_COORDINATED";
  vendorId: string | null;
  officeCode: string | null;
}

export function ArtworkRoutingEditor({
  action,
  offices,
  vendors,
  current,
}: {
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  offices: RoutingEditorOffice[];
  vendors: RoutingEditorVendor[];
  current: CurrentRouting[];
}) {
  const currentOffice = current.find((r) => r.kind === "EXPO_IN_HOUSE")?.officeCode ?? "";
  const currentVendorIds = current.filter((r) => r.kind === "VENDOR").map((r) => r.vendorId!);
  const amPmInitially = current.some((r) => r.kind === "AM_PM_COORDINATED");

  const [inHouse, setInHouse] = useState(Boolean(currentOffice));
  const [amPm, setAmPm] = useState(amPmInitially);

  return (
    <ActionForm action={action} className="flex flex-col gap-4">
      {offices.length > 0 && (
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="inHouse"
              value="1"
              checked={inHouse}
              onChange={(e) => setInHouse(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="font-medium">Expo produces this in-house</span>
          </label>
          {inHouse && (
            <select
              name="officeCode"
              defaultValue={currentOffice || offices[0]?.code}
              className="mt-2 ml-6 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            >
              {offices.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div>
        <p className="mb-1.5 text-sm font-medium">Outside print shops</p>
        <div className="max-h-56 overflow-y-auto rounded-md border border-neutral-200 p-2">
          {vendors.length === 0 ? (
            <p className="px-1 py-2 text-xs text-neutral-500">No print shops in the catalog yet.</p>
          ) : (
            vendors.map((v) => (
              <label key={v.id} className="flex items-center gap-2 px-1 py-1 text-sm">
                <input
                  type="checkbox"
                  name="vendorIds"
                  value={v.id}
                  defaultChecked={currentVendorIds.includes(v.id)}
                  className="h-4 w-4"
                />
                <span>{v.name}</span>
              </label>
            ))
          )}
        </div>
        <p className="mt-1 text-xs text-neutral-500">Tick more than one when the piece is split between shops.</p>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="amPm"
            value="1"
            checked={amPm}
            onChange={(e) => setAmPm(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="font-medium">The AM/PM coordinates the printing</span>
        </label>
        {amPm && (
          <input
            name="amPmNote"
            defaultValue={current.find((r) => r.kind === "AM_PM_COORDINATED") ? undefined : ""}
            placeholder="Which shop, if known (optional)"
            className="mt-2 ml-6 w-64 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
        )}
      </div>

      <div>
        <button type="submit" className="rounded-md bg-brand-black px-3 py-2 text-sm font-medium text-white">
          Save routing
        </button>
      </div>
    </ActionForm>
  );
}
