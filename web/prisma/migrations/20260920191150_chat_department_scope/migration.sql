-- AlterEnum
BEGIN;
CREATE TYPE "ChatThreadScope_new" AS ENUM ('OPPORTUNITY', 'DEPARTMENT');
ALTER TABLE "public"."chat_threads" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TABLE "chat_threads" ALTER COLUMN "scope" TYPE "ChatThreadScope_new" USING ("scope"::text::"ChatThreadScope_new");
ALTER TYPE "ChatThreadScope" RENAME TO "ChatThreadScope_old";
ALTER TYPE "ChatThreadScope_new" RENAME TO "ChatThreadScope";
DROP TYPE "public"."ChatThreadScope_old";
ALTER TABLE "chat_threads" ALTER COLUMN "scope" SET DEFAULT 'OPPORTUNITY';
COMMIT;

-- AlterTable
ALTER TABLE "chat_threads" ADD COLUMN     "departmentCode" TEXT;
