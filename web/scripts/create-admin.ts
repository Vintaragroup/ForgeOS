// Bootstraps the first super admin -- solves the same chicken-and-egg
// problem set-password.ts solves for passwords: the admin UI requires
// being logged in as an admin to create a user, so the very first one has
// to come from the host instead. Upserts by email (safe to re-run).
//
// Run with: npx tsx scripts/create-admin.ts <name> <email> <password>

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/session";

async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error("Usage: npx tsx scripts/create-admin.ts <name> <email> <password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const passwordHash = await hashPassword(password);
  const user = await db.user.upsert({
    where: { email },
    create: { name, email, passwordHash, systemRole: "SUPER_ADMIN" },
    update: { name, passwordHash, systemRole: "SUPER_ADMIN", deletedAt: null },
  });

  console.log(`Super admin ready: ${user.name} <${user.email}>.`);
  await db.$disconnect();
}

main();
