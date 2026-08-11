"use client";

import { useState } from "react";
import { Field, SelectField } from "@/components/ui";

// Mirrors project-type-fields.tsx's pattern: rateType drives which fields
// are relevant. DEPARTMENT (shop labor) is a single flat number -- no
// tier/union concept. CITY_MARKET (show/site labor) needs a tier
// (straight/overtime/double time, each a real independently-set rate --
// see LaborRateTier's schema comment on why these aren't computed from a
// multiplier) and an optional union status.
export const RATE_TYPE_OPTIONS = [
  { value: "DEPARTMENT", label: "Department (internal shop labor)" },
  { value: "CITY_MARKET", label: "City market (on-site/show labor)" },
];

const TIER_OPTIONS = [
  { value: "STRAIGHT_TIME", label: "Straight time" },
  { value: "OVERTIME", label: "Overtime" },
  { value: "DOUBLE_TIME", label: "Double time" },
];

const UNION_OPTIONS = [
  { value: "", label: "— unspecified —" },
  { value: "UNION", label: "Union" },
  { value: "NON_UNION", label: "Non-union" },
];

export interface LaborRateFieldDefaults {
  rateType: string;
  departmentCode: string;
  departmentName: string;
  city: string;
  laborTier: string;
  unionStatus: string;
  notes: string;
}

export function LaborRateFields({ defaults }: { defaults: LaborRateFieldDefaults }) {
  const [rateType, setRateType] = useState(defaults.rateType);

  return (
    <>
      <SelectField
        label="Rate type"
        name="rateType"
        defaultValue={defaults.rateType}
        required
        options={RATE_TYPE_OPTIONS}
        onChange={setRateType}
      />

      {rateType === "DEPARTMENT" && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Department code" name="departmentCode" defaultValue={defaults.departmentCode} placeholder="e.g. EF" />
          <Field
            label="Department name"
            name="departmentName"
            defaultValue={defaults.departmentName}
            placeholder="e.g. Exhibit Fabrication"
          />
        </div>
      )}

      {rateType === "CITY_MARKET" && (
        <>
          <Field label="City / market" name="city" defaultValue={defaults.city} placeholder="e.g. Orlando, FL" />
          <div className="grid grid-cols-2 gap-4">
            <SelectField label="Tier" name="laborTier" defaultValue={defaults.laborTier} options={TIER_OPTIONS} />
            <SelectField label="Union status" name="unionStatus" defaultValue={defaults.unionStatus} options={UNION_OPTIONS} />
          </div>
          <Field label="Notes" name="notes" defaultValue={defaults.notes} placeholder="e.g. Travel Required" />
        </>
      )}
    </>
  );
}
