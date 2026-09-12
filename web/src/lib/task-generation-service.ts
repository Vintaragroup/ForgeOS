// Sales-to-production handoff, Piece 3: turns a locked, signed estimate's
// own line items into a real starting task list per department/vendor,
// instead of a coordinator hand-retyping the whole estimate into blank
// task rows. Kept separate from project-service.ts (deliberately plain
// CRUD, per its own header comment) the same way cut-list-nesting-
// service.ts is kept separate from estimate-service.ts -- this is a
// distinct, substantial chunk of grouping/business logic, not a thin
// wrapper over a Prisma call.

import { db } from "@/lib/db";
import { resolveProductionEstimateVersion } from "@/lib/project-service";
import { resolveEffectiveCategory } from "@/lib/proposal-view-model";

// Only two of the live Category catalog's real names have a genuinely
// clean 1:1 match against LaborRate's 16 real shop-department codes
// (prisma/seed.ts) -- everything else either spans multiple shop
// departments (Custom Build alone covers electrical/metal/CNC/laminating
// work) or has no shop department at all (there is no "AV" code among the
// 16 real ones, so Audio/Visual scope is routed to an external Vendor by
// hand instead, via the manual link/unlink UI, not auto-guessed here).
// Matched against resolveEffectiveCategory's own return value, which is a
// real Category.name, not a lowercase key.
const CATEGORY_TO_DEPARTMENT: Record<string, string> = {
  Graphics: "GR",
  Shipping: "SR",
};

const UNASSIGNED_TASK_DESCRIPTION = "Unassigned scope -- needs department/vendor review";

// Resolves the department code for one line item -- LineItem.department
// (already populated with a real shop-department code for labor lines
// specifically, schema.prisma's own comment: "labor lines only, business-
// rules.md Rule 1 department codes") is a more authoritative per-item
// signal than any category-level guess, so it wins outright when present.
function resolveDepartmentCode(lineItem: { department: string | null }, effectiveCategory: string): string | null {
  if (lineItem.department) return lineItem.department;
  return CATEGORY_TO_DEPARTMENT[effectiveCategory] ?? null;
}

export interface GenerateTasksResult {
  created: number;
  updated: number;
  unassignedCount: number;
}

// Idempotent by construction: only ever reads line items with taskId ===
// null (unclaimed) -- an item already linked, whether by a prior run of
// this same function or by a coordinator's own manual link, is never
// touched or re-grouped. Running this twice in a row with nothing new on
// the estimate is a real no-op (created: 0, updated: 0, unassignedCount:
// 0), not a duplicate-task generator.
export async function generateTasksFromEstimate(projectId: string, workOrderId: string): Promise<GenerateTasksResult> {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  // projectId ownership check -- same pattern as every other
  // project-service.ts function taking both ids.
  await db.workOrder.findFirstOrThrow({ where: { id: workOrderId, projectId } });

  const lockedVersion = await resolveProductionEstimateVersion(project.opportunityId);
  if (!lockedVersion) {
    return { created: 0, updated: 0, unassignedCount: 0 };
  }

  const [unclaimedItems, categories] = await Promise.all([
    db.lineItem.findMany({
      where: { section: { estimateVersionId: lockedVersion.id }, taskId: null },
      select: {
        id: true,
        category: true,
        department: true,
        section: { select: { groupLabel: true, buildType: true } },
      },
    }),
    db.category.findMany({ where: { deletedAt: null } }),
  ]);

  // Grouped by department code across the WHOLE locked version, not per
  // EstimateSection -- a department needs every relevant item across the
  // whole show in one list, not fragmented per booth component. Same
  // cross-booth-aggregation reasoning LineItem.category itself exists for
  // (schema.prisma's own comment on that field).
  const groups = new Map<string | null, string[]>();
  for (const item of unclaimedItems) {
    const effectiveCategory = resolveEffectiveCategory(item, item.section, categories);
    const departmentCode = resolveDepartmentCode(item, effectiveCategory);
    const ids = groups.get(departmentCode) ?? [];
    ids.push(item.id);
    groups.set(departmentCode, ids);
  }

  // Real department names for a nicer task description than a bare code
  // -- one query for every code that actually appears, not N+1 per group.
  const realCodes = [...groups.keys()].filter((code): code is string => code !== null);
  const laborRates =
    realCodes.length > 0
      ? await db.laborRate.findMany({ where: { departmentCode: { in: realCodes } }, select: { departmentCode: true, departmentName: true } })
      : [];
  const departmentNames = new Map(laborRates.map((r) => [r.departmentCode, r.departmentName]));

  function taskDescriptionFor(departmentCode: string | null): string {
    if (departmentCode === null) return UNASSIGNED_TASK_DESCRIPTION;
    const name = departmentNames.get(departmentCode);
    return name ? `${name} scope` : `${departmentCode} department scope`;
  }

  let created = 0;
  let updated = 0;
  let unassignedCount = 0;

  await db.$transaction(async (tx) => {
    for (const [departmentCode, lineItemIds] of groups) {
      if (lineItemIds.length === 0) continue;
      if (departmentCode === null) unassignedCount += lineItemIds.length;

      const description = taskDescriptionFor(departmentCode);
      // Matches on BOTH departmentCode and this exact, canonical
      // description -- not departmentCode alone. A manually-created task
      // that happens to share a department code (or share null, meaning
      // "no department set") but has its own different free-text
      // description must never silently absorb this run's items; only a
      // task this same function already created for this exact
      // department is a genuine "append to the existing one" match.
      const existingTask = await tx.task.findFirst({ where: { workOrderId, departmentCode, description } });
      if (existingTask) {
        updated += lineItemIds.length;
        await tx.lineItem.updateMany({ where: { id: { in: lineItemIds } }, data: { taskId: existingTask.id } });
      } else {
        const task = await tx.task.create({ data: { workOrderId, description, departmentCode } });
        created++;
        await tx.lineItem.updateMany({ where: { id: { in: lineItemIds } }, data: { taskId: task.id } });
      }
    }
  });

  return { created, updated, unassignedCount };
}
