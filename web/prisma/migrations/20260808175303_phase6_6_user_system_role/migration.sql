-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'EMPLOYEE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "systemRole" "SystemRole" NOT NULL DEFAULT 'EMPLOYEE';
