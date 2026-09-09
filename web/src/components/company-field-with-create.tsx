"use client";

import { useState } from "react";
import { Field, SelectField } from "@/components/ui";
import { NEW_COMPANY_VALUE } from "@/lib/opportunity-new-company";

// Same "watch a plain <select>, toggle what's mounted" split as
// project-type-fields.tsx -- the surrounding <form> stays a plain Server
// Action post; this only decides whether the inline "New client name"
// field is present at submit time. createOpportunity (opportunities/actions.ts)
// is what actually creates the Company row when NEW_COMPANY_VALUE is
// submitted -- this component only collects the name, never writes
// anything itself.
//
// Real gap this closes: creating an opportunity for a client that doesn't
// exist yet used to mean abandoning this form, creating the company on a
// separate page, then starting over here. companyId still submits as the
// same field name either way, so no other part of this form (or
// createOpportunity itself) needs to know which path was used until the
// action reads the sentinel value. See opportunity-new-company.ts for why
// NEW_COMPANY_VALUE itself isn't declared in this file.
export function CompanyFieldWithCreate({ companies }: { companies: { id: string; name: string }[] }) {
  const [isNewCompany, setIsNewCompany] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label="Company"
        name="companyId"
        required
        options={[
          // Last, not first -- a plain <select> defaults to whichever
          // option is first in the DOM, and an existing company should
          // stay the default pick (same as this form's own prior
          // behavior), not "create a new client" every time the page
          // loads with no deliberate choice made.
          ...companies.map((c) => ({ value: c.id, label: c.name })),
          { value: NEW_COMPANY_VALUE, label: "+ New client" },
        ]}
        onChange={(value) => setIsNewCompany(value === NEW_COMPANY_VALUE)}
      />
      {isNewCompany && (
        <Field label="New client name" name="newCompanyName" required placeholder="e.g. Acme Corp" />
      )}
    </div>
  );
}
