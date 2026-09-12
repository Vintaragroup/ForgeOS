-- AlterTable
ALTER TABLE "users" ADD COLUMN     "departmentCode" TEXT;

-- CreateTable
CREATE TABLE "departments" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("code")
);

-- Seed data, not just DDL: the FK constraints added below validate EXISTING
-- labor_rates/tasks rows' departmentCode values against this table, so the
-- 21 codes must exist before those constraints can be added. This mirrors
-- prisma/seed.ts's own DEPARTMENTS block (kept in sync there for future
-- idempotent upserts) -- both are the source of truth for the same 21
-- rows, not two different lists.
INSERT INTO "departments" ("code", "name", "updatedAt") VALUES
    ('SL', 'Sales', CURRENT_TIMESTAMP),
    ('ES', 'Estimating', CURRENT_TIMESTAMP),
    ('PM', 'Project Management', CURRENT_TIMESTAMP),
    ('AM', 'Account Management', CURRENT_TIMESTAMP),
    ('DE', 'Design', CURRENT_TIMESTAMP),
    ('EN', 'Engineering', CURRENT_TIMESTAMP),
    ('PU', 'Purchasing', CURRENT_TIMESTAMP),
    ('GR', 'Graphics', CURRENT_TIMESTAMP),
    ('CC', 'CNC', CURRENT_TIMESTAMP),
    ('EF', 'Exhibit Fabrication', CURRENT_TIMESTAMP),
    ('ME', 'Metal', CURRENT_TIMESTAMP),
    ('LP', 'Laminating/Painting', CURRENT_TIMESTAMP),
    ('EL', 'Electrical', CURRENT_TIMESTAMP),
    ('AV', 'Audio/Visual', CURRENT_TIMESTAMP),
    ('AS', 'Assembly', CURRENT_TIMESTAMP),
    ('CR', 'Crates', CURRENT_TIMESTAMP),
    ('HA', 'Handling', CURRENT_TIMESTAMP),
    ('ID', 'Install & Dismantle', CURRENT_TIMESTAMP),
    ('WH', 'Warehouse', CURRENT_TIMESTAMP),
    ('RC', 'Receiving', CURRENT_TIMESTAMP),
    ('SR', 'Shipping', CURRENT_TIMESTAMP);

-- Any labor_rates row whose departmentCode isn't one of the 21 above (e.g.
-- a stale/manually-entered code) would otherwise fail the FK constraint
-- below outright, aborting the whole migration -- nulling it out instead
-- surfaces as a visible "needs review" gap (a labor rate with no
-- department linked) rather than blocking deployment. None expected in
-- practice since the 21 codes are a strict superset of the pre-existing
-- 16, but this is the honest, non-destructive way to handle it if wrong.
UPDATE "labor_rates" SET "departmentCode" = NULL
WHERE "departmentCode" IS NOT NULL AND "departmentCode" NOT IN (SELECT "code" FROM "departments");

UPDATE "tasks" SET "departmentCode" = NULL
WHERE "departmentCode" IS NOT NULL AND "departmentCode" NOT IN (SELECT "code" FROM "departments");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_departmentCode_fkey" FOREIGN KEY ("departmentCode") REFERENCES "departments"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labor_rates" ADD CONSTRAINT "labor_rates_departmentCode_fkey" FOREIGN KEY ("departmentCode") REFERENCES "departments"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_departmentCode_fkey" FOREIGN KEY ("departmentCode") REFERENCES "departments"("code") ON DELETE SET NULL ON UPDATE CASCADE;
