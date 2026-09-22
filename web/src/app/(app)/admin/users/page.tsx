import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  ADMIN: "Admin",
  EMPLOYEE: "Employee",
};

export default async function AdminUsersPage() {
  const users = await db.user.findMany({
    orderBy: { name: "asc" },
    include: { departmentRef: { select: { name: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Users"
        action={
          <div className="flex items-center gap-2">
            <LinkButton href="/admin/integrations/salesmate" variant="secondary">
              Salesmate
            </LinkButton>
            <LinkButton href="/admin/audit-log" variant="secondary">
              Audit log
            </LinkButton>
            <LinkButton href="/admin/users/new">New user</LinkButton>
          </div>
        }
      />
      {users.length === 0 ? (
        <EmptyState message="No users yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {users.map((user) => (
              <li key={user.id}>
                <Link
                  href={`/admin/users/${user.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      {user.name}
                      {user.deletedAt && <StatusChip tone="critical">Deactivated</StatusChip>}
                      {user.adminNote && <StatusChip tone="warning">Needs attention</StatusChip>}
                    </div>
                    <div className="text-sm text-neutral-500">{user.email}</div>
                    {user.adminNote && <div className="text-sm text-amber-700">{user.adminNote}</div>}
                  </div>
                  {/* Department, not just system role. Assigning people to
                      departments is what gates the department dashboards
                      and their assistants, and with only the role shown
                      there was no way to see who was still unassigned
                      without opening all 25 records one at a time. */}
                  <div className="flex shrink-0 items-center gap-2 text-sm text-neutral-500">
                    {user.departmentRef ? (
                      <StatusChip tone="neutral">{user.departmentRef.name}</StatusChip>
                    ) : (
                      <StatusChip tone="warning">No department</StatusChip>
                    )}
                    {user.isDepartmentHead && <StatusChip tone="good">Head</StatusChip>}
                    <span>{ROLE_LABELS[user.systemRole] ?? user.systemRole}</span>
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
