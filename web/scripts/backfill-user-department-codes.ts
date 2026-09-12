// One-time (re-runnable) backfill for User.departmentCode from the legacy
// free-text User.department field -- see prisma/schema.prisma's User model
// comment for why department is deprecated but not yet dropped. Only ever
// maps a User whose departmentCode is still null (never overwrites a value
// someone already set deliberately through /admin/users), and only on a
// confident case-insensitive exact match against a real Department's code
// or name -- no fuzzy/partial matching, since a wrong department grants
// real access (see department-access.ts) that a wrong guess here could
// mistakenly hand someone. Anyone who doesn't map cleanly is left alone and
// printed in the report for manual fixup via the admin UI.
//
// Run with: npx tsx scripts/backfill-user-department-codes.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const departments = await db.department.findMany({ where: { deletedAt: null } });
  const byCode = new Map(departments.map((d) => [d.code.toLowerCase(), d]));
  const byName = new Map(departments.map((d) => [d.name.toLowerCase(), d]));

  const users = await db.user.findMany({
    where: { deletedAt: null, departmentCode: null, department: { not: null } },
    select: { id: true, name: true, email: true, department: true },
  });

  let mapped = 0;
  const unmapped: { name: string; email: string; department: string }[] = [];

  for (const user of users) {
    const raw = user.department!.trim().toLowerCase();
    const match = byCode.get(raw) ?? byName.get(raw);
    if (match) {
      await db.user.update({ where: { id: user.id }, data: { departmentCode: match.code } });
      mapped++;
    } else {
      unmapped.push({ name: user.name, email: user.email, department: user.department! });
    }
  }

  console.log(`Mapped ${mapped} of ${users.length} users with a legacy department value to a real Department.`);
  if (unmapped.length > 0) {
    console.log(`\n${unmapped.length} user(s) need manual review (no confident match) -- fix via /admin/users/[id]:`);
    for (const u of unmapped) {
      console.log(`  - ${u.name} <${u.email}>: "${u.department}"`);
    }
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
