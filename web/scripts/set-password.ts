// Sets (or resets) a user's login password directly against the database.
// Deliberately a host-run CLI script, not a web form -- there is no
// unauthenticated "set your password" route, matching this project's
// existing pattern of running schema/data-sensitive operations explicitly
// from the host (migrations, seed) rather than automating them over HTTP.
//
// Run with: npx tsx scripts/set-password.ts <email> <password>

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/session";

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Usage: npx tsx scripts/set-password.ts <email> <password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const user = await db.user.findFirst({ where: { email, deletedAt: null } });
  if (!user) {
    console.error(`No user found with email ${email}. Create one at /users/new first.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  // passwordChangedAt invalidates any session issued before this reset --
  // see src/lib/session.ts's buildSessionValue / src/lib/auth.ts's
  // getCurrentUser -- so a CLI-forced reset actually logs out whatever
  // session prompted needing this reset in the first place.
  await db.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });

  console.log(`Password set for ${user.name} <${user.email}>.`);
  await db.$disconnect();
}

main();
