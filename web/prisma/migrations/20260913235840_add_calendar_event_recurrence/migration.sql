-- CreateEnum
CREATE TYPE "CalendarEventRecurrence" AS ENUM ('NONE', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN     "recurrence" "CalendarEventRecurrence" NOT NULL DEFAULT 'NONE';
