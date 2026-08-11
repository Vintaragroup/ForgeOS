import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteProposalTemplate, updateProposalTemplate } from "../actions";
import { Button, Card, Field, PageHeader, TextareaField } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

function stringField(value: unknown, key: string): string {
  if (value && typeof value === "object" && key in value) {
    const v = (value as Record<string, unknown>)[key];
    return typeof v === "string" ? v : "";
  }
  return "";
}

export default async function ProposalTemplateDetailPage(
  props: PageProps<"/catalog/proposal-templates/[id]">,
) {
  const { id } = await props.params;
  const template = await db.proposalTemplate.findFirst({ where: { id, deletedAt: null } });
  if (!template) notFound();

  const updateWithId = updateProposalTemplate.bind(null, template.id);
  const deleteWithId = deleteProposalTemplate.bind(null, template.id);

  return (
    <div>
      <PageHeader title={template.name} backHref="/catalog/proposal-templates" backLabel="Proposal templates" />
      <Card className="p-6">
        <form action={updateWithId} className="flex flex-col gap-4">
          <Field label="Template name" name="name" defaultValue={template.name} required />
          <Field
            label="Brand color"
            name="brandColor"
            defaultValue={stringField(template.brandingConfig, "color")}
            placeholder="e.g. #001B6C (brand navy)"
          />
          <Field
            label="Logo URL"
            name="logoUrl"
            defaultValue={stringField(template.brandingConfig, "logoUrl")}
            placeholder="https://…"
          />
          <Field
            label="Layout note"
            name="layoutNote"
            defaultValue={stringField(template.layoutConfig, "note")}
            placeholder="Freeform notes on layout/branding"
          />
          <TextareaField
            label="Professional Services scope (one item per line)"
            name="professionalServicesItems"
            rows={6}
            defaultValue={stringField(template.layoutConfig, "professionalServicesItems")}
            hint="Rendered as a bullet list above the estimate's own 'Professional Services' section, if one exists. No price of its own -- that comes from the estimate's line items."
          />
          <TextareaField
            label="Terms & Conditions (one clause per line)"
            name="termsAndConditions"
            rows={10}
            defaultValue={stringField(template.layoutConfig, "termsAndConditions")}
            hint="Auto-numbered and rendered as a Terms & Conditions page with signature blocks at the end of the PDF."
          />
          <Field
            label="Payment method note"
            name="paymentMethodNote"
            defaultValue={stringField(template.layoutConfig, "paymentMethodNote")}
            placeholder="3.5% convenience fee (credit card)"
          />
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteWithId}
          confirmMessage="Delete this proposal template? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete template</Button>
        </ConfirmForm>
      </Card>
    </div>
  );
}
