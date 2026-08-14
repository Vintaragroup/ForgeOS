import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { getCutListCostReport, type CutListCostReport } from "@/lib/cut-list-nesting-service";
import type { Prisma } from "@/generated/prisma/client";
import {
  addShipmentAction,
  addTaskAction,
  deleteShipmentAction,
  deleteTaskAction,
  startWorkOrderAction,
  updateProjectDetailsAction,
  updateShipmentAction,
  updateTaskStatusAction,
  updateWorkOrderAction,
} from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

const PROJECT_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "COMPLETE", label: "Complete" },
  { value: "CANCELLED", label: "Cancelled" },
];

const WORK_ORDER_STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft" },
  { value: "IN_PRODUCTION", label: "In production" },
  { value: "READY_TO_SHIP", label: "Ready to ship" },
  { value: "INSTALLED", label: "Installed" },
  { value: "COMPLETE", label: "Complete" },
];

const TASK_STATUS_OPTIONS = [
  { value: "TODO", label: "To do" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "DONE", label: "Done" },
  { value: "BLOCKED", label: "Blocked" },
];

const SHIPMENT_STATUS_OPTIONS = [
  { value: "PLANNED", label: "Planned" },
  { value: "SHIPPED", label: "Shipped" },
  { value: "DELIVERED", label: "Delivered" },
];

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function ProjectDetailPage(props: PageProps<"/projects/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const project = await db.project.findFirst({
    where: { id, deletedAt: null },
    include: {
      opportunity: { include: { company: true } },
      workOrders: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
          tasks: {
            where: { deletedAt: null },
            orderBy: { createdAt: "asc" },
            include: { assignedTo: true, vendor: true },
          },
          shipments: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!project) notFound();
  if (!(await canAccessOpportunity(user, project.opportunityId))) notFound();

  const workOrder = project.workOrders[0];
  const [users, vendors] = await Promise.all([
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.vendor.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
  ]);

  // Project has no direct FK to Estimate/EstimateVersion -- deliberate,
  // both already reach the same Opportunity, so a second direct link
  // would just be a redundant path to the same data (see the schema
  // comment above the Project model). "The accepted estimate" for
  // production is derived here instead: the most recently locked version
  // across every Estimate this Opportunity has (usually one, but an
  // Opportunity can have more -- e.g. two separate exhibits). Only a
  // LOCKED version's cut list is shown -- that's the real signal an
  // estimate is settled, same gate cut-list/page.tsx itself now enforces
  // (Phase 6).
  const lockedVersion = await db.estimateVersion.findFirst({
    where: { estimate: { opportunityId: project.opportunityId }, isLocked: true },
    orderBy: { versionNumber: "desc" },
  });
  let cutListReport: CutListCostReport | null = null;
  if (lockedVersion) {
    cutListReport = await getCutListCostReport(lockedVersion.id);
  }

  const updateProjectWithId = updateProjectDetailsAction.bind(null, project.id);
  const startWorkOrderWithId = startWorkOrderAction.bind(null, project.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={project.jobNumber ? `Job ${project.jobNumber}` : `Project — ${project.opportunity.showName}`}
        action={
          <Link href={`/opportunities/${project.opportunity.id}`} className="text-sm text-neutral-500 hover:text-neutral-900">
            ← {project.opportunity.company.name}
          </Link>
        }
      />

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Details
        </h2>
        <form action={updateProjectWithId} className="flex flex-col gap-4" key={project.status}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Job number" name="jobNumber" defaultValue={project.jobNumber ?? ""} placeholder="e.g. J-1001" />
            <SelectField label="Status" name="status" defaultValue={project.status} options={PROJECT_STATUS_OPTIONS} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Show start date" name="showStartDate" type="date" defaultValue={fmtDate(project.showStartDate)} />
            <Field label="Show end date" name="showEndDate" type="date" defaultValue={fmtDate(project.showEndDate)} />
          </div>
          <div>
            <Button>Save changes</Button>
          </div>
        </form>
      </Card>

      {lockedVersion && cutListReport && cutListReport.materials.length > 0 && (
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Cut list</h2>
            <Link
              href={`/estimates/${lockedVersion.estimateId}/versions/${lockedVersion.id}/cut-list`}
              className="text-sm text-brand-navy hover:underline"
            >
              View full cut list →
            </Link>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-400">Total material cost</div>
              <div className="text-lg font-semibold">{money(cutListReport.totalCost)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-400">Total sheets</div>
              <div className="text-lg font-semibold">{cutListReport.totalSheetsUsed}</div>
            </div>
          </div>
          <ul className="flex flex-col divide-y divide-neutral-200 text-sm">
            {cutListReport.materials.map((m) => (
              <li key={m.materialId} className="flex flex-wrap items-center gap-4 py-2">
                <span className="flex-1 font-medium">{m.materialName}</span>
                <span>
                  <strong>{m.sheetsUsed}</strong> sheet{m.sheetsUsed === 1 ? "" : "s"}
                  {m.remnantSheetsUsed > 0 && (
                    <span className="text-neutral-500">
                      {" "}
                      ({m.remnantSheetsUsed} remnant, {m.freshSheetsUsed} fresh)
                    </span>
                  )}
                </span>
                <span>
                  <strong>{money(m.totalCost)}</strong>
                </span>
                <span className="text-neutral-500">{(m.wastePct * 100).toFixed(1)}% waste</span>
                <Link
                  href={`/estimates/${lockedVersion.estimateId}/versions/${lockedVersion.id}/cut-list/${m.materialId}/diagram`}
                  target="_blank"
                  className="text-brand-navy hover:underline"
                >
                  Diagram (PDF)
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!workOrder ? (
        <Card className="p-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Work order
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            No work order yet. Starting one opens the production timeline for this job.
          </p>
          <form action={startWorkOrderWithId}>
            <Button>Start work order</Button>
          </form>
        </Card>
      ) : (
        <WorkOrderCard projectId={project.id} workOrder={workOrder} users={users} vendors={vendors} />
      )}
    </div>
  );
}

type WorkOrderWithTasks = Prisma.WorkOrderGetPayload<{
  include: { tasks: { include: { assignedTo: true; vendor: true } }; shipments: true };
}>;

function WorkOrderCard({
  projectId,
  workOrder,
  users,
  vendors,
}: {
  projectId: string;
  workOrder: WorkOrderWithTasks;
  users: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
}) {
  const updateWorkOrderWithIds = updateWorkOrderAction.bind(null, projectId, workOrder.id);
  const addTaskWithIds = addTaskAction.bind(null, projectId, workOrder.id);
  const addShipmentWithIds = addShipmentAction.bind(null, projectId, workOrder.id);

  return (
    <Card className="p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Work order — timeline
      </h2>
      <form action={updateWorkOrderWithIds} className="mb-8 flex flex-col gap-4" key={workOrder.status}>
        <div className="w-56">
          <SelectField label="Status" name="status" defaultValue={workOrder.status} options={WORK_ORDER_STATUS_OPTIONS} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Deposit due" name="depositDueDate" type="date" defaultValue={fmtDate(workOrder.depositDueDate)} />
          <Field
            label="Production meeting"
            name="productionMeetingDate"
            type="date"
            defaultValue={fmtDate(workOrder.productionMeetingDate)}
          />
          <Field
            label="Artwork deadline"
            name="artworkDeadlineDate"
            type="date"
            defaultValue={fmtDate(workOrder.artworkDeadlineDate)}
          />
          <Field label="Balance due" name="balanceDueDate" type="date" defaultValue={fmtDate(workOrder.balanceDueDate)} />
          <Field label="Install date" name="installDate" type="date" defaultValue={fmtDate(workOrder.installDate)} />
        </div>
        <div>
          <Button>Save timeline</Button>
        </div>
      </form>

      <div className="border-t border-neutral-200 pt-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Tasks</h3>
        {workOrder.tasks.length > 0 && (
          <table className="mb-4 w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="pb-1 font-normal">Description</th>
                <th className="pb-1 font-normal">Dept</th>
                <th className="pb-1 font-normal">Assigned to</th>
                <th className="pb-1 font-normal">Vendor</th>
                <th className="pb-1 font-normal">Due</th>
                <th className="pb-1 font-normal">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {workOrder.tasks.map((task) => {
                const updateStatusWithIds = updateTaskStatusAction.bind(null, projectId, task.id);
                const deleteWithIds = deleteTaskAction.bind(null, projectId, task.id);
                return (
                  <tr key={task.id} className="border-t border-neutral-100">
                    <td className="py-1.5">{task.description}</td>
                    <td className="py-1.5">{task.departmentCode ?? ""}</td>
                    <td className="py-1.5">{task.assignedTo?.name ?? ""}</td>
                    <td className="py-1.5">{task.vendor?.name ?? ""}</td>
                    <td className="py-1.5">{fmtDate(task.dueDate)}</td>
                    <td className="py-1.5">
                      <form action={updateStatusWithIds} className="flex items-center gap-1.5">
                        <select
                          // Forces React to remount this uncontrolled select
                          // when the server-side status changes -- otherwise
                          // the DOM node is reused across the Server
                          // Action's re-render and keeps showing the
                          // pre-submit value (same bug/fix as the
                          // Opportunity stage select).
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
                    </td>
                    <td className="py-1.5 text-right">
                      <form action={deleteWithIds}>
                        <button className="text-xs text-red-500 hover:underline">remove</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <form action={addTaskWithIds} className="flex flex-wrap items-end gap-3 rounded-md bg-neutral-50 p-3">
          <div className="flex-1 min-w-[10rem]">
            <Field label="Description" name="description" required />
          </div>
          <div className="w-24">
            <Field label="Dept" name="departmentCode" placeholder="EF" />
          </div>
          <div className="w-40">
            <SelectField
              label="Assigned to"
              name="assignedToId"
              options={[{ value: "", label: "— unassigned —" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
            />
          </div>
          {vendors.length > 0 && (
            <div className="w-40">
              <SelectField
                label="Vendor (purchasing)"
                name="vendorId"
                options={[{ value: "", label: "— none —" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
              />
            </div>
          )}
          <div className="w-40">
            <Field label="Due date" name="dueDate" type="date" />
          </div>
          <Button variant="secondary">Add task</Button>
        </form>
      </div>

      <div className="mt-8 border-t border-neutral-200 pt-6">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Shipments</h3>
        {workOrder.shipments.length > 0 && (
          <table className="mb-4 w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="pb-1 font-normal">Carrier</th>
                <th className="pb-1 font-normal">Load list</th>
                <th className="pb-1 font-normal">Ship date</th>
                <th className="pb-1 font-normal">Tracking / status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {workOrder.shipments.map((shipment) => {
                const updateShipmentWithIds = updateShipmentAction.bind(null, projectId, shipment.id);
                const deleteShipmentWithIds = deleteShipmentAction.bind(null, projectId, shipment.id);
                return (
                  <tr key={shipment.id} className="border-t border-neutral-100">
                    <td className="py-1.5">{shipment.carrier ?? ""}</td>
                    <td className="py-1.5">{shipment.loadListNote ?? ""}</td>
                    <td className="py-1.5">{fmtDate(shipment.shipDate)}</td>
                    <td className="py-1.5">
                      <form action={updateShipmentWithIds} className="flex items-center gap-1.5">
                        <input
                          type="text"
                          name="trackingRef"
                          defaultValue={shipment.trackingRef ?? ""}
                          placeholder="Tracking #"
                          className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                        />
                        <select
                          key={shipment.status}
                          name="status"
                          defaultValue={shipment.status}
                          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-neutral-500"
                        >
                          {SHIPMENT_STATUS_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <button className="text-xs text-neutral-700 hover:underline">update</button>
                      </form>
                    </td>
                    <td className="py-1.5 text-right">
                      <form action={deleteShipmentWithIds}>
                        <button className="text-xs text-red-500 hover:underline">remove</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <form action={addShipmentWithIds} className="flex flex-wrap items-end gap-3 rounded-md bg-neutral-50 p-3">
          <div className="w-40">
            <Field label="Carrier" name="carrier" placeholder="e.g. ABC Freight" />
          </div>
          <div className="flex-1 min-w-[10rem]">
            <Field label="Load list note" name="loadListNote" placeholder="e.g. 2 crates, 1 skid" />
          </div>
          <div className="w-40">
            <Field label="Ship date" name="shipDate" type="date" />
          </div>
          <Button variant="secondary">Add shipment</Button>
        </form>
      </div>
    </Card>
  );
}
