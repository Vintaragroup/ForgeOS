import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getTasksForUser } from "@/lib/tasks";
import { PageHeader, Card } from "@/components/ui";
import { updateTaskStatusAction, deleteTaskAction } from "../projects/actions";

export const dynamic = "force-dynamic";

const TASK_STATUS_OPTIONS = [
  { value: "TODO", label: "To do" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "DONE", label: "Done" },
  { value: "BLOCKED", label: "Blocked" },
];

const TASK_STATUS_LABELS: Record<string, string> = Object.fromEntries(TASK_STATUS_OPTIONS.map((o) => [o.value, o.label]));

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

const TAB_BASE = "rounded-md border px-3 py-1.5 text-sm font-medium";
const TAB_ACTIVE = `${TAB_BASE} border-brand-navy bg-brand-navy text-white`;
const TAB_INACTIVE = `${TAB_BASE} border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50`;

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: "mine" | "all"; completed?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { view, completed } = await searchParams;
  const mineOnly = view !== "all";
  const includeCompleted = completed === "1";
  const tasks = await getTasksForUser(user, { mineOnly, includeCompleted });

  const qs = (v: "mine" | "all", c: boolean) => `/tasks?view=${v}${c ? "&completed=1" : ""}`;

  return (
    <div>
      <PageHeader
        title="Tasks"
        action={
          <div className="flex items-center gap-2">
            <Link href={qs("mine", includeCompleted)} className={mineOnly ? TAB_ACTIVE : TAB_INACTIVE}>
              My tasks
            </Link>
            <Link href={qs("all", includeCompleted)} className={!mineOnly ? TAB_ACTIVE : TAB_INACTIVE}>
              All tasks
            </Link>
            <Link href={qs(mineOnly ? "mine" : "all", !includeCompleted)} className={TAB_INACTIVE}>
              {includeCompleted ? "Hide completed" : "Show completed"}
            </Link>
          </div>
        }
      />
      <Card className="overflow-x-auto p-4">
        {tasks.length === 0 ? (
          <p className="text-sm text-neutral-400">No tasks to show.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="pb-1 font-normal">Description</th>
                <th className="pb-1 font-normal">Show / Company</th>
                <th className="pb-1 font-normal">Dept</th>
                <th className="pb-1 font-normal">Assigned to</th>
                <th className="pb-1 font-normal">Vendor</th>
                <th className="pb-1 font-normal">Due</th>
                <th className="pb-1 font-normal">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const updateStatusWithIds = updateTaskStatusAction.bind(null, task.projectId, task.id);
                const deleteWithIds = deleteTaskAction.bind(null, task.projectId, task.id);
                return (
                  <tr key={task.id} className="border-t border-neutral-100">
                    <td className="py-1.5">{task.description}</td>
                    <td className="py-1.5">
                      <Link href={`/opportunities/${task.opportunityId}`} className="text-brand-navy hover:underline">
                        {task.showName}
                      </Link>
                      <div className="text-xs text-neutral-400">{task.companyName}</div>
                    </td>
                    <td className="py-1.5">{task.departmentName ?? ""}</td>
                    <td className="py-1.5">{task.assignedToName ?? ""}</td>
                    <td className="py-1.5">{task.vendorName ?? ""}</td>
                    <td className="py-1.5">{fmtDate(task.dueDate)}</td>
                    <td className="py-1.5">
                      {task.canManage ? (
                        <form action={updateStatusWithIds} className="flex items-center gap-1.5">
                          <select
                            key={task.status}
                            name="status"
                            defaultValue={task.status}
                            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-neutral-500"
                          >
                            {TASK_STATUS_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          <button className="text-xs text-neutral-700 hover:underline">update</button>
                        </form>
                      ) : (
                        <span className="text-xs text-neutral-500">{TASK_STATUS_LABELS[task.status] ?? task.status}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-1.5 text-right">
                      <a
                        href={`/projects/${task.projectId}/tasks/${task.id}/packet`}
                        target="_blank"
                        rel="noreferrer"
                        className="mr-3 text-xs text-brand-navy hover:underline"
                      >
                        Packet (PDF)
                      </a>
                      {task.canManage && (
                        <form action={deleteWithIds} className="inline">
                          <button className="text-xs text-red-500 hover:underline">remove</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
