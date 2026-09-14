// One-time (re-runnable) pull of Salesmate's real Users (internal sales
// reps) into ForgeOS's User table -- fixes the "no matching User by name"
// gap the Graphics log import's own dry run surfaced (every AE name in the
// legacy log went unmatched, since no User rows existed with those real
// names/emails). Matched against Opportunity.salesRepId by exact name at
// import time (see resolveSalesRepId in import-pga-graphics-log.ts).
//
// Auth: GET https://{domain}.salesmate.io/apis/core/v4/users with
// `accessToken` + `x-linkname` headers -- confirmed live against the real
// account before writing this (find-or-create by email, never a guess).
// Requires SALESMATE_ACCESS_TOKEN (the Session Key, not the Access Key --
// see My Account -> Access Key in Salesmate) and SALESMATE_DOMAIN in
// web/.env.
//
// Imported users get no password (passwordHash stays null) -- they can't
// log in until someone runs `npm run set-password` or sets one via
// /admin/users, same as any other account creation in this codebase. This
// script only ever creates the identity record needed for salesRepId
// matching, never login access.
//
// Safety: defaults to a dry run that only prints a plan. Pass --apply to
// actually write. Re-running is safe -- find-or-create by email, never
// duplicates, and never overwrites a name/departmentCode someone already
// set by hand in ForgeOS (see the update branch below).
//
// Usage:
//   npx tsx scripts/import-salesmate-users.ts             # dry run
//   npx tsx scripts/import-salesmate-users.ts --apply      # writes

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const rawDomain = requireEnv("SALESMATE_DOMAIN");
// Tolerant of the domain being entered as a bare subdomain, a full
// hostname, or a full URL -- see this script's own discovery process.
const domain = rawDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.salesmate\.io$/, "");
const accessToken = requireEnv("SALESMATE_ACCESS_TOKEN");

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const db = new PrismaClient({ adapter });

interface SalesmateUser {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  mobile: string | null;
  isActive: number;
}

async function fetchSalesmateUsers(): Promise<SalesmateUser[]> {
  const res = await fetch(`https://${domain}.salesmate.io/apis/core/v4/users`, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      accessToken,
      "x-linkname": `${domain}.salesmate.io`,
    },
  });
  if (!res.ok) {
    throw new Error(`Salesmate API returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { Status: string; Data: SalesmateUser[] };
  if (body.Status !== "success") {
    throw new Error(`Salesmate API returned a non-success status: ${JSON.stringify(body)}`);
  }
  return body.Data;
}

async function main() {
  console.log(APPLY ? "Running with --apply: this WILL write to the database." : "Dry run (pass --apply to write).");

  const salesmateUsers = await fetchSalesmateUsers();
  // Only currently-active reps -- an inactive Salesmate user isn't a real
  // current sales rep, and importing one would just be dead data.
  const active = salesmateUsers.filter((u) => u.isActive === 1);
  console.log(`Salesmate returned ${salesmateUsers.length} users, ${active.length} active.\n`);

  let created = 0;
  let unchanged = 0;
  const skippedNoEmail: string[] = [];

  for (const su of active) {
    if (!su.email) {
      skippedNoEmail.push(su.name);
      continue;
    }
    const existing = await db.user.findFirst({ where: { email: { equals: su.email, mode: "insensitive" } } });
    if (!existing) {
      console.log(`+ create: ${su.name} <${su.email}>`);
      created++;
      if (APPLY) {
        await db.user.create({ data: { name: su.name, email: su.email.toLowerCase() } });
      }
      continue;
    }
    // Never overwrite a name someone already set by hand in ForgeOS's own
    // admin UI -- only fill in if it's genuinely still the exact same
    // (i.e. this is a no-op re-run), matching
    // scripts/backfill-user-department-codes.ts's own "don't clobber a
    // deliberate manual value" posture.
    if (existing.name !== su.name) {
      console.log(`~ name differs, left alone: ForgeOS has "${existing.name}", Salesmate has "${su.name}" (${su.email})`);
    }
    unchanged++;
  }

  console.log("\n--- Summary ---");
  console.log(`Created: ${created}`);
  console.log(`Already existed (unchanged): ${unchanged}`);
  if (skippedNoEmail.length > 0) {
    console.log(`Skipped (no email on file in Salesmate): ${skippedNoEmail.join(", ")}`);
  }
  if (!APPLY) {
    console.log("\nThis was a dry run -- nothing was written. Re-run with --apply to commit.");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
