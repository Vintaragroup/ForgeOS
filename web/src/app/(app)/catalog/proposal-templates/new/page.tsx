import { createProposalTemplate } from "../actions";
import { Button, Card, Field, PageHeader, TextareaField } from "@/components/ui";

export default function NewProposalTemplatePage() {
  return (
    <div>
      <PageHeader title="New proposal template" backHref="/catalog/proposal-templates" backLabel="Proposal templates" />
      <Card className="p-6">
        <form action={createProposalTemplate} className="flex flex-col gap-4">
          <Field label="Template name" name="name" required />
          <Field label="Brand color" name="brandColor" placeholder="e.g. #001B6C (brand navy)" />
          <Field label="Logo URL" name="logoUrl" placeholder="https://…" />
          <Field label="Layout note" name="layoutNote" placeholder="Freeform notes on layout/branding" />
          <TextareaField
            label="Professional Services scope (one item per line)"
            name="professionalServicesItems"
            rows={6}
            placeholder={"Project Coordination & Development\nProject Management\nEngineering\nCAD Shop Production Drawings"}
            hint="Rendered as a bullet list above the estimate's own 'Professional Services' section, if one exists. No price of its own -- that comes from the estimate's line items."
          />
          <TextareaField
            label="Terms & Conditions (one clause per line)"
            name="termsAndConditions"
            rows={10}
            placeholder={"INSURANCE-...\nPROPRIETARY INFORMATION-...\nFORCE MAJEURE-..."}
            hint="Auto-numbered and rendered as a Terms & Conditions page with signature blocks at the end of the PDF."
          />
          <Field
            label="Payment method note"
            name="paymentMethodNote"
            placeholder="3.5% convenience fee (credit card)"
          />
          <div>
            <Button>Create template</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
