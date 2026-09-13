-- AlterTable
ALTER TABLE "shows" ADD COLUMN     "escalationContactId" TEXT;

-- AddForeignKey
ALTER TABLE "shows" ADD CONSTRAINT "shows_escalationContactId_fkey" FOREIGN KEY ("escalationContactId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
