-- CreateEnum
CREATE TYPE "LineItemAuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateTable
CREATE TABLE "line_item_audit_logs" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "lineItemId" TEXT,
    "description" TEXT NOT NULL,
    "action" "LineItemAuditAction" NOT NULL,
    "detail" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "line_item_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "line_item_audit_logs_estimateVersionId_createdAt_idx" ON "line_item_audit_logs"("estimateVersionId", "createdAt");

-- AddForeignKey
ALTER TABLE "line_item_audit_logs" ADD CONSTRAINT "line_item_audit_logs_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_item_audit_logs" ADD CONSTRAINT "line_item_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
