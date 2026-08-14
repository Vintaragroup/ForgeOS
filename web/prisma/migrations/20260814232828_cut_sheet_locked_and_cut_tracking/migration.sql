-- AlterTable
ALTER TABLE "cut_sheets" ADD COLUMN     "cutAt" TIMESTAMP(3),
ADD COLUMN     "locked" BOOLEAN NOT NULL DEFAULT false;

