import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

export default async function ProposalTemplatesPage() {
  const templates = await db.proposalTemplate.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    include: { _count: { select: { proposals: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Proposal templates"
        action={<LinkButton href="/catalog/proposal-templates/new">New template</LinkButton>}
      />
      {templates.length === 0 ? (
        <EmptyState message="No proposal templates yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {templates.map((template) => (
              <li key={template.id}>
                <Link
                  href={`/catalog/proposal-templates/${template.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div className="font-medium">{template.name}</div>
                  <div className="text-sm text-neutral-500">
                    {template._count.proposals} proposal{template._count.proposals === 1 ? "" : "s"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
