// Sales-to-production handoff, Piece 4: downloads a cost-free PDF packet
// for one production Task -- see task-packet-pdf.tsx's own header comment
// for why this is a distinct trust tier from the other two PDFs in this
// app. Same GET-route-renders-live-on-every-request shape as the cut-list
// export/labels routes right next to this pattern's other precedent.
import { notFound } from "next/navigation";
import { renderToBuffer } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { buildTaskPacketData, TaskPacketPdfDocument } from "@/lib/task-packet-pdf";

export async function GET(_request: Request, { params }: RouteContext<"/projects/[id]/tasks/[taskId]/packet">) {
  const { id, taskId } = await params;

  const user = await getCurrentUser();
  if (!user) notFound();

  const task = await db.task.findFirst({
    where: { id: taskId, deletedAt: null, workOrder: { projectId: id } },
    include: {
      vendor: { select: { name: true } },
      workOrder: {
        include: {
          project: {
            include: { opportunity: { select: { id: true, showName: true, company: { select: { name: true } } } } },
          },
        },
      },
      lineItems: { select: { description: true, qty: true, unit: true, category: true }, orderBy: { description: "asc" } },
    },
  });
  if (!task) notFound();

  const opportunity = task.workOrder.project.opportunity;
  if (!(await canAccessOpportunity(user, opportunity.id))) notFound();

  const departmentName = task.departmentCode
    ? (await db.laborRate.findFirst({ where: { departmentCode: task.departmentCode }, select: { departmentName: true } }))
        ?.departmentName ?? null
    : null;

  const data = buildTaskPacketData({
    showName: opportunity.showName,
    companyName: opportunity.company.name,
    jobNumber: task.workOrder.project.jobNumber,
    taskDescription: task.description,
    departmentCode: task.departmentCode,
    departmentName,
    vendorName: task.vendor?.name ?? null,
    dueDate: task.dueDate,
    lineItems: task.lineItems.map((li) => ({
      description: li.description,
      qty: li.qty.toNumber(),
      unit: li.unit,
      category: li.category,
    })),
  });

  const buffer = await renderToBuffer(TaskPacketPdfDocument({ data }));
  const filename = `task-packet-${task.description.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
