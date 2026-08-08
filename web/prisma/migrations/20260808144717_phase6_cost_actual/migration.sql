-- CreateTable
CREATE TABLE "cost_actuals" (
    "id" TEXT NOT NULL,
    "lineItemId" TEXT,
    "taskId" TEXT,
    "actualCost" DECIMAL(12,2) NOT NULL,
    "source" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_actuals_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "cost_actuals" ADD CONSTRAINT "cost_actuals_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_actuals" ADD CONSTRAINT "cost_actuals_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_actuals" ADD CONSTRAINT "cost_actuals_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
