-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'MEETING_NOTES';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "estimateId" TEXT;

-- AlterTable
ALTER TABLE "estimates" ADD COLUMN     "name" TEXT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
