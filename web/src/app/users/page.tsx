import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const [users, requester] = await Promise.all([
    db.user.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    getCurrentUser(),
  ]);
  const isAdmin = requester?.systemRole === "ADMIN" || requester?.systemRole === "SUPER_ADMIN";

  return (
    <div>
      <PageHeader
        title="Users"
        action={isAdmin ? <LinkButton href="/admin/users/new">New user</LinkButton> : undefined}
      />
      {users.length === 0 ? (
        <EmptyState message="No internal users yet. Add estimators, account executives, or production staff." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {users.map((user) => (
              <li key={user.id} className="flex items-center justify-between px-5 py-4">
                <div>
                  <div className="font-medium">{user.name}</div>
                  <div className="text-sm text-neutral-500">{user.email}</div>
                </div>
                <div className="text-sm text-neutral-500">
                  {[user.role, user.department].filter(Boolean).join(" · ") || "—"}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
