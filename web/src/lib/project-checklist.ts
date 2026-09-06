// A Project's own "what's next" list, mirroring deal-checklist.ts's
// architecture exactly (pure function, already-fetched inputs, computed
// fresh every render, no DB writes, no caching) -- covers the gap
// deal-checklist.ts's own WON branch leaves behind the moment a Project
// actually exists (it returns [] once projectCount > 0): a bare "Convert
// to a Project" link stops being useful, but nothing before this told an
// Account Manager the job number was still blank or the production
// timeline still had nulls in it.

import type { DealChecklistItem } from "@/lib/deal-checklist";

export interface ProjectChecklistInput {
  projectId: string;
  jobNumber: string | null;
  workOrder: {
    depositDueDate: Date | null;
    productionMeetingDate: Date | null;
    artworkDeadlineDate: Date | null;
    balanceDueDate: Date | null;
  } | null;
}

export function buildProjectChecklist(input: ProjectChecklistInput): DealChecklistItem[] {
  const items: DealChecklistItem[] = [];

  if (!input.jobNumber) {
    items.push({
      id: "missing-job-number",
      label: "Add the job number for this project.",
      href: `/projects/${input.projectId}#details`,
      urgent: false,
    });
  }

  if (!input.workOrder) {
    items.push({
      id: "start-work-order",
      label: "Start the work order to begin tracking production.",
      href: `/projects/${input.projectId}#work-order`,
      urgent: false,
    });
    return items; // nothing else to check until a WorkOrder exists
  }

  const missingDateCount = [
    input.workOrder.depositDueDate,
    input.workOrder.productionMeetingDate,
    input.workOrder.artworkDeadlineDate,
    input.workOrder.balanceDueDate,
  ].filter((d) => d === null).length;

  if (missingDateCount > 0) {
    items.push({
      id: "work-order-dates-incomplete",
      label: `Fill in ${missingDateCount} missing production date${missingDateCount === 1 ? "" : "s"} on the work order.`,
      href: `/projects/${input.projectId}#work-order`,
      urgent: false,
    });
  }

  return items;
}
