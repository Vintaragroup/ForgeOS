import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, Pagination, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function ProposalTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const where = { deletedAt: null };
  const [templates, total] = await Promise.all([
    db.proposalTemplate.findMany({
      where,
      orderBy: { name: "asc" },
      include: { _count: { select: { proposals: true } } },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.proposalTemplate.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Proposal templates"
        backHref="/catalog"
        backLabel="Catalog"
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
      <Pagination page={page} totalPages={totalPages} basePath="/catalog/proposal-templates" />
    </div>
  );
}
