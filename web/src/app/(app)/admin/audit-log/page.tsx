import { db } from "@/lib/db";
import { Card, EmptyState, PageHeader, Pagination, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

const ACTION_LABELS: Record<string, string> = {
  "user.create": "User created",
  "user.role_change": "Role changed",
  "user.deactivate": "User deactivated",
  "user.reactivate": "User reactivated",
};

const ACTION_TONES: Record<string, "good" | "warning" | "critical" | "neutral"> = {
  "user.create": "good",
  "user.role_change": "warning",
  "user.deactivate": "critical",
  "user.reactivate": "neutral",
};

// B23: read-only trail of the admin/users actions that change who can
// access ForgeOS or what they can do in it -- see AdminAuditLog in
// schema.prisma and the logAdminAction() call sites in admin/users/actions.ts.
export default async function AdminAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

  const [entries, total] = await Promise.all([
    db.adminAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        actor: { select: { name: true, email: true } },
        targetUser: { select: { name: true, email: true } },
      },
    }),
    db.adminAuditLog.count(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader title="Audit log" backHref="/admin/users" backLabel="Users" />
      {entries.length === 0 ? (
        <EmptyState message="No admin actions recorded yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <StatusChip tone={ACTION_TONES[entry.action] ?? "neutral"}>
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </StatusChip>
                    <span className="text-sm text-neutral-500">
                      by {entry.actor?.name ?? "Unknown"}
                      {entry.targetUser ? ` → ${entry.targetUser.name}` : ""}
                    </span>
                  </div>
                  {entry.detail && <div className="mt-1 text-sm text-neutral-600">{entry.detail}</div>}
                </div>
                <div className="shrink-0 text-sm text-neutral-400">
                  {entry.createdAt.toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Pagination page={page} totalPages={totalPages} basePath="/admin/audit-log" />
    </div>
  );
}
