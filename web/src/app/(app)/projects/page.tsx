import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { Card, EmptyState, PageHeader, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

function ProjectStatusChip({ status }: { status: string }) {
  switch (status) {
    case "COMPLETE":
      return <StatusChip tone="good">Complete</StatusChip>;
    case "ON_HOLD":
      return <StatusChip tone="warning">On hold</StatusChip>;
    case "CANCELLED":
      return <StatusChip tone="critical">Cancelled</StatusChip>;
    default:
      return <StatusChip tone="info">Active</StatusChip>;
  }
}

export default async function ProjectsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const projects = await db.project.findMany({
    where: { deletedAt: null, opportunity: opportunityAccessWhere(user) },
    orderBy: { createdAt: "desc" },
    include: { opportunity: { include: { company: true } } },
  });

  return (
    <div>
      <PageHeader title="Projects" />
      {projects.length === 0 ? (
        <EmptyState message="No projects yet. Convert a won opportunity to start one." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">
                      {project.jobNumber ? `Job ${project.jobNumber}` : project.opportunity.showName}
                    </div>
                    <div className="text-sm text-neutral-500">{project.opportunity.company.name}</div>
                  </div>
                  <ProjectStatusChip status={project.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
