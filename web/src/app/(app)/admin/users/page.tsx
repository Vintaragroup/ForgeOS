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
  const users = await db.user.findMany({ orderBy: { name: "asc" } });

  return (
    <div>
      <PageHeader
        title="Users"
        action={<LinkButton href="/admin/users/new">New user</LinkButton>}
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
                    </div>
                    <div className="text-sm text-neutral-500">{user.email}</div>
                  </div>
                  <div className="text-sm text-neutral-500">
                    {ROLE_LABELS[user.systemRole] ?? user.systemRole}
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
