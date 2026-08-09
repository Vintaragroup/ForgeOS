import { createProposalTemplate } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

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
          <div>
            <Button>Create template</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
