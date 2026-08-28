// A real, durable audit trail for vendor-match "apply" events -- see
// VendorMatchApplyLog's own schema comment for why this exists
// separately from BidPackage.matchResult (which only ever holds current
// state). Called from every code path in bid-package-actions.ts that
// writes a vendor price onto a LineItem, right after that write
// succeeds -- never wrapped in a try/catch that swallows failures, since
// silently dropping an audit record defeats the entire point of this
// table (unlike ai-usage-service.ts's recordAiUsage, which is an
// approximate cost dashboard, not the feature itself).

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

export type VendorMatchApplyMethod = "single" | "group" | "all_high_confidence" | "selected";

export async function recordVendorMatchApply(params: {
  estimateVersionId: string;
  bidPackageId: string;
  bidPackageName: string;
  lineItemId: string;
  targetDescription: string;
  targetSectionLabel: string | null;
  vendorLineDescriptions: string[];
  qty: number;
  unitCost: number;
  totalCost: number;
  confidence: string | null;
  documentId: string;
  documentFilename: string;
  method: VendorMatchApplyMethod;
  actorId: string;
}): Promise<void> {
  await db.vendorMatchApplyLog.create({
    data: {
      estimateVersionId: params.estimateVersionId,
      bidPackageId: params.bidPackageId,
      bidPackageName: params.bidPackageName,
      lineItemId: params.lineItemId,
      targetDescription: params.targetDescription,
      targetSectionLabel: params.targetSectionLabel,
      vendorLineDescriptions: params.vendorLineDescriptions.join(" | "),
      vendorLineCount: params.vendorLineDescriptions.length,
      qty: new Prisma.Decimal(params.qty),
      unitCost: new Prisma.Decimal(params.unitCost),
      totalCost: new Prisma.Decimal(params.totalCost),
      confidence: params.confidence,
      documentId: params.documentId,
      documentFilename: params.documentFilename,
      method: params.method,
      actorId: params.actorId,
    },
  });
}

export async function getVendorMatchApplyLog(estimateVersionId: string) {
  return db.vendorMatchApplyLog.findMany({
    where: { estimateVersionId },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}
