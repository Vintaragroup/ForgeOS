-- AlterTable
ALTER TABLE "line_items" ADD COLUMN     "taskId" TEXT;

-- CreateIndex
CREATE INDEX "line_items_taskId_idx" ON "line_items"("taskId");

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
