// Actual-cost capture and estimate-vs-actual variance (docs/migration-plan.md
// Phase 6). Kept separate from Server Action wrappers the same way every
// other service in this project is (see opportunity-service.ts's header
// comment). AI-assisted estimating/risk detection are deliberately not
// built this phase -- see schema.prisma's Phase 6 header comment for why.

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

type Decimal = Prisma.Decimal;
type DecimalInput = Decimal | number | string;

// Append-only (data-model-v0.md's CostActual: "Versioning: append-only")
// -- no update/delete here; a correction is a new entry, not an edit to
// history. Must reference a LineItem and/or a Task -- enforced here
// rather than at the DB level, matching Attachment's minimalism.
export async function recordCostActual(data: {
  lineItemId?: string | null;
  taskId?: string | null;
  actualCost: DecimalInput;
  source?: string | null;
  recordedById?: string | null;
}) {
  if (!data.lineItemId && !data.taskId) {
    throw new Error("A cost actual must reference a LineItem or a Task.");
  }
  return db.costActual.create({
    data: {
      lineItemId: data.lineItemId ?? null,
      taskId: data.taskId ?? null,
      actualCost: new Prisma.Decimal(data.actualCost),
      source: data.source ?? null,
      recordedById: data.recordedById ?? null,
    },
  });
}

export function computeActualTotal(costActuals: { actualCost: DecimalInput }[]): Decimal {
  return costActuals.reduce((sum, ca) => sum.plus(ca.actualCost), new Prisma.Decimal(0));
}

export interface LineItemVariance {
  lineItemId: string;
  description: string;
  department: string | null;
  estimatedCost: Decimal;
  actualCost: Decimal;
  variance: Decimal; // actual - estimated; positive = over budget
}

// Mirrors Price Summary!E6/F6's "ESTIMATED COST"/"ACTUAL INCURRED" pair
// (business-rules.md/data-model-v0.md's CostActual) -- the one thing the
// workbook names but never populates with real structured data.
export function computeLineItemVariance(lineItems: {
  id: string;
  description: string;
  department: string | null;
  totalCost: DecimalInput;
  costActuals: { actualCost: DecimalInput }[];
}[]): LineItemVariance[] {
  return lineItems.map((li) => {
    const estimatedCost = new Prisma.Decimal(li.totalCost);
    const actualCost = computeActualTotal(li.costActuals);
    return {
      lineItemId: li.id,
      description: li.description,
      department: li.department,
      estimatedCost,
      actualCost,
      variance: actualCost.minus(estimatedCost),
    };
  });
}

export interface DepartmentVariance {
  department: string;
  estimatedCost: Decimal;
  actualCost: Decimal;
  variance: Decimal;
}

// Rolls up per-line-item variance by department -- "variance reporting
// ... by department/category/job" (migration-plan.md Phase 6 scope).
// Rows with no department are grouped under "Unassigned" rather than
// dropped, so the rollup total always reconciles with the line-item sum.
export function computeDepartmentVariance(rows: LineItemVariance[]): DepartmentVariance[] {
  const byDept = new Map<string, { estimatedCost: Decimal; actualCost: Decimal }>();
  for (const row of rows) {
    const key = row.department ?? "Unassigned";
    const existing = byDept.get(key) ?? { estimatedCost: new Prisma.Decimal(0), actualCost: new Prisma.Decimal(0) };
    byDept.set(key, {
      estimatedCost: existing.estimatedCost.plus(row.estimatedCost),
      actualCost: existing.actualCost.plus(row.actualCost),
    });
  }
  return Array.from(byDept.entries()).map(([department, totals]) => ({
    department,
    estimatedCost: totals.estimatedCost,
    actualCost: totals.actualCost,
    variance: totals.actualCost.minus(totals.estimatedCost),
  }));
}
