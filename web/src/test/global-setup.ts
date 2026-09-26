// Brings forgeos_test up to the current schema before any test runs.
//
// Adding a column used to fail the whole suite -- hundreds of unrelated
// tests red, all reporting a missing column, because the test database had
// been created once and never migrated since. It happened three times in a
// single day's work, each time costing a confused minute before the real
// cause surfaced, so the fix belongs here rather than in a habit of
// remembering to run the ALTER by hand.
//
// `migrate deploy` applies pending migrations only and never resets or
// drops -- the same command the production deploy runs. A test database
// that is already current is a no-op.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { config } from "dotenv";

export default function setup() {
  const envPath = path.resolve(import.meta.dirname, "../../.env.test");
  const parsed = config({ path: envPath }).parsed ?? {};
  const databaseUrl = parsed.DATABASE_URL ?? process.env.DATABASE_URL;

  // The same guard src/test/setup.ts applies, repeated because this runs
  // first and in its own process: migrations are schema writes, and the
  // one thing worse than a stale test database is a migrated dev one.
  if (!databaseUrl?.includes("forgeos_test")) {
    throw new Error(
      `Refusing to migrate: DATABASE_URL does not point at forgeos_test (got ${databaseUrl}). ` +
        "This runs schema migrations -- never point it at forgeos_dev.",
    );
  }

  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  } catch (err) {
    // execFileSync puts the real explanation in stdout/stderr buffers,
    // which vitest renders as a wall of byte values if they escape as-is.
    // A failed migration in the test database is the likely cause and the
    // message says how to clear it, so it is worth reading.
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const detail = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join("\n").trim();
    throw new Error(
      `prisma migrate deploy failed against forgeos_test.\n\n${detail}\n\n` +
        "If a migration is recorded as started but never finished (a killed test run will do it), " +
        "clear it with: npx prisma migrate resolve --applied <migration_name>",
    );
  }
}
