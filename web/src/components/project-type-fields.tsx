"use client";

import { useState } from "react";
import { Field, SelectField, TextareaField } from "@/components/ui";

// The fifth client component in this app (see document-upload-form.tsx's
// header comment on the fourth) -- selecting a project type needs to
// reveal a different field group beneath it without a full page reload.
// The underlying <form> is still a plain Server Action post; this only
// toggles which of the uncontrolled inputs are mounted before submit, the
// same division of labor as DocumentUploadForm's drag state vs its real
// upload.
export const PROJECT_TYPE_OPTIONS = [
  { value: "TRADESHOW_EXHIBIT", label: "Tradeshow Exhibit" },
  { value: "EVENT", label: "Event" },
  { value: "EXHIBITOR_CONTRACTING", label: "Exhibitor Contracting" },
  { value: "SPECIALIZED_PROJECT", label: "Specialized Project" },
  { value: "OTHER", label: "Other" },
];

const BOOTH_SPACE_OPTIONS = [
  { value: "", label: "— unspecified —" },
  { value: "ISLAND", label: "Island" },
  { value: "PENINSULA", label: "Peninsula" },
  { value: "IN_LINE", label: "In-line" },
  { value: "PERIMETER", label: "Perimeter" },
];

const BOOTH_TYPE_OPTIONS = [
  { value: "", label: "— unspecified —" },
  { value: "RENTAL", label: "Rental" },
  { value: "PURCHASE", label: "Purchase" },
  { value: "CLIENT_OWNED", label: "Client owned" },
];

export interface ProjectTypeFieldDefaults {
  projectType: string;
  boothNumber: string;
  boothSize: string;
  boothSpace: string;
  boothType: string;
  shipDate: string;
  venue: string;
  eventStartDate: string;
  eventEndDate: string;
  siteAddress: string;
  projectDetails: string;
}

// Field groups shown per type. Venue + event start/end are universal
// (every type has some kind of location and a start/end window, even a
// one-off SPECIALIZED_PROJECT) -- everything else is type-specific.
const SHOWS_BOOTH_DIMENSIONS = new Set(["TRADESHOW_EXHIBIT"]);
const SHOWS_BOOTH_NUMBER = new Set(["TRADESHOW_EXHIBIT", "EXHIBITOR_CONTRACTING"]);
const SHOWS_SITE_FIELDS = new Set(["SPECIALIZED_PROJECT", "OTHER"]);

export function ProjectTypeFields({ defaults }: { defaults: ProjectTypeFieldDefaults }) {
  const [projectType, setProjectType] = useState(defaults.projectType);

  return (
    <>
      <SelectField
        label="Project type"
        name="projectType"
        defaultValue={defaults.projectType}
        required
        options={PROJECT_TYPE_OPTIONS}
        onChange={setProjectType}
      />

      <div className="grid grid-cols-2 gap-4">
        <Field label="Venue / location" name="venue" defaultValue={defaults.venue} />
        <div />
        <Field label="Event start date" name="eventStartDate" type="date" defaultValue={defaults.eventStartDate} />
        <Field label="Event end date" name="eventEndDate" type="date" defaultValue={defaults.eventEndDate} />
      </div>

      {SHOWS_BOOTH_NUMBER.has(projectType) && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Booth number" name="boothNumber" defaultValue={defaults.boothNumber} />
          <SelectField
            label="Booth type"
            name="boothType"
            defaultValue={defaults.boothType}
            options={BOOTH_TYPE_OPTIONS}
          />
        </div>
      )}

      {SHOWS_BOOTH_DIMENSIONS.has(projectType) && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Booth size" name="boothSize" defaultValue={defaults.boothSize} placeholder="e.g. 20x20" />
          <SelectField
            label="Booth space"
            name="boothSpace"
            defaultValue={defaults.boothSpace}
            options={BOOTH_SPACE_OPTIONS}
          />
          <Field label="Ship date" name="shipDate" type="date" defaultValue={defaults.shipDate} />
        </div>
      )}

      {SHOWS_SITE_FIELDS.has(projectType) && (
        <>
          <Field label="Site address" name="siteAddress" defaultValue={defaults.siteAddress} />
          <TextareaField
            label="Project details"
            name="projectDetails"
            defaultValue={defaults.projectDetails}
            hint="Fill in what you know now -- most of the detail for this type usually comes from AI reading uploaded RFPs, meeting notes, or email chains once they're attached below."
            rows={4}
          />
        </>
      )}
    </>
  );
}
