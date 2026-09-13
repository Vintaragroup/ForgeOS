// Cross-project "my tasks" / "everything I can see" reads for the /tasks
// page and the Dashboard's "My Tasks" quick-action count. Its own service
// file, same reasoning calendar.ts's own header comment gives for staying
// separate from dashboard.ts -- this spans every Project/WorkOrder rather
// than one already-known Project (unlike project-service.ts's own Task
// functions), and needs its own testable, page-independent module.

import type { SystemRole } from "@/generated/prisma/client";
import type { TaskStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { opportunityAccessWhere } from "@/lib/opportunity-access";

type TasksUser = { id: string; systemRole: SystemRole };

export interface TaskListItem {
  id: string;
  description: string;
  status: TaskStatus;
  dueDate: Date | null;
  departmentName: string | null;
  assignedToName: string | null;
  vendorName: string | null;
  projectId: string;
  opportunityId: string;
  showName: string;
  companyName: string;
  // updateTaskStatusAction/deleteTaskAction both require project (i.e.
  // opportunity) access -- an assignee-only viewer (assigned the task but
  // not an owner/collaborator on its opportunity) can see it here but
  // can't mutate it. The page uses this to render a read-only status
  // instead of a form that would throw "You don't have access to this
  // opportunity" on submit.
  canManage: boolean;
}

// mineOnly: true drops the opportunity-access OR-branch entirely --
// "assigned to me" means exactly that, even off an opportunity the caller
// can't otherwise see (matches calendar.ts's own Task query, which
// already OR's assignedToId in for this same reason).
export async function getTasksForUser(
  user: TasksUser,
  opts: { mineOnly: boolean; includeCompleted: boolean },
): Promise<TaskListItem[]> {
  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      // A completed task is no longer actionable -- same rule calendar.ts
      // already applies to its own Task query.
      ...(opts.includeCompleted ? {} : { status: { not: "DONE" as TaskStatus } }),
      ...(opts.mineOnly
        ? { assignedToId: user.id }
        : { OR: [{ assignedToId: user.id }, { workOrder: { project: { opportunity: opportunityAccessWhere(user) } } }] }),
    },
    select: {
      id: true,
      description: true,
      status: true,
      dueDate: true,
      department: { select: { name: true } },
      assignedTo: { select: { name: true } },
      vendor: { select: { name: true } },
      workOrder: {
        select: {
          projectId: true,
          project: {
            select: {
              opportunityId: true,
              opportunity: { select: { showName: true, company: { select: { name: true } } } },
            },
          },
        },
      },
    },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });

  // Which of these tasks' opportunities the caller can actually manage --
  // same opportunityAccessWhere rule updateTaskStatusAction/deleteTaskAction
  // enforce via requireProjectAccess, computed once here so canManage below
  // doesn't need a per-row query.
  const opportunityIds = [...new Set(tasks.map((t) => t.workOrder.project.opportunityId))];
  const manageable = await db.opportunity.findMany({
    where: { id: { in: opportunityIds }, ...opportunityAccessWhere(user) },
    select: { id: true },
  });
  const manageableIds = new Set(manageable.map((o) => o.id));

  return tasks.map((t) => ({
    id: t.id,
    description: t.description,
    status: t.status,
    dueDate: t.dueDate,
    departmentName: t.department?.name ?? null,
    assignedToName: t.assignedTo?.name ?? null,
    vendorName: t.vendor?.name ?? null,
    projectId: t.workOrder.projectId,
    opportunityId: t.workOrder.project.opportunityId,
    showName: t.workOrder.project.opportunity.showName,
    companyName: t.workOrder.project.opportunity.company.name,
    canManage: manageableIds.has(t.workOrder.project.opportunityId),
  }));
}
