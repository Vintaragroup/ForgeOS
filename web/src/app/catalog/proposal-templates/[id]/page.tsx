import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteProposalTemplate, updateProposalTemplate } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

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
      <PageHeader title={template.name} />
      <Card className="p-6">
        <form action={updateWithId} className="flex flex-col gap-4">
          <Field label="Template name" name="name" defaultValue={template.name} required />
          <Field
            label="Brand color"
            name="brandColor"
            defaultValue={stringField(template.brandingConfig, "color")}
            placeholder="e.g. #1f5c73"
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
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <form action={deleteWithId} className="mt-4 border-t border-neutral-200 pt-4">
          <Button variant="danger">Delete template</Button>
        </form>
      </Card>
    </div>
  );
}
