// Unsticks a deploy that dies on:
//
//   Error: P1002 ... Timed out trying to acquire a postgres advisory lock
//   (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.
//
// That means some session still holds the migrate lock. Since 2026-09-20
// migrations run over a direct connection (see
// src/lib/direct-database-url.ts), which is the actual fix -- this script
// is the rescue path for a lock that leaked before that, or for any other
// session that grabbed it and went away.
//
// It connects directly too, because a pooled connection would be a lousy
// place to diagnose a pooling problem: you can't tell which backend you
// reached.
//
// Usage:
//   npx tsx scripts/clear-migrate-lock.ts            # report only
//   npx tsx scripts/clear-migrate-lock.ts --apply    # terminate idle holders
//
// Against production, DATABASE_URL must point at production:
//   DATABASE_URL="postgresql://...:6432/forgeos?sslmode=require" npx tsx scripts/clear-migrate-lock.ts
//
// --apply only terminates a holder that is plain `idle`: no query running,
// no open transaction, so nothing is half-done when it's cut off. A holder
// that is actually working (`active`, or `idle in transaction`) is
// reported and left alone -- that one may be a migrate genuinely in
// flight, and killing it mid-migration is how you get a half-applied
// schema.

import "dotenv/config";
import pg from "pg";
import { directDatabaseUrl, MIGRATE_ADVISORY_LOCK_ID } from "../src/lib/direct-database-url";

const APPLY = process.argv.includes("--apply");
const SAFE_TO_KILL = "idle";

type Holder = {
  pid: number;
  state: string | null;
  granted: boolean;
  state_change: Date | null;
  query: string | null;
  application_name: string | null;
};

async function main() {
  const url = directDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set.");

  const client = new pg.Client({
    connectionString: url,
    // Render terminates TLS with its own chain; the app's adapter accepts
    // it the same way.
    ssl: url.includes("render.com") ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();

  const { rows: where } = await client.query<{ host: string; port: number; db: string }>(
    "select inet_server_addr()::text as host, inet_server_port() as port, current_database() as db",
  );
  console.log(`connected to ${where[0]?.db} (backend port ${where[0]?.port})`);
  console.log(`looking for advisory lock ${MIGRATE_ADVISORY_LOCK_ID}\n`);

  const { rows: holders } = await client.query<Holder>(
    `select l.pid,
            l.granted,
            a.state,
            a.state_change,
            a.application_name,
            left(a.query, 120) as query
       from pg_locks l
       left join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory'
        and l.objid = $1
      order by l.granted desc, l.pid`,
    [MIGRATE_ADVISORY_LOCK_ID],
  );

  if (holders.length === 0) {
    console.log("No one holds or waits on the migrate lock. A redeploy should go through.");
    await client.end();
    return;
  }

  for (const h of holders) {
    const verb = h.granted ? "HOLDS" : "waits on";
    const idleFor = h.state_change ? ` since ${h.state_change.toISOString()}` : "";
    console.log(`pid ${h.pid} ${verb} the lock -- state=${h.state ?? "?"}${idleFor}`);
    console.log(`  app:   ${h.application_name || "(none)"}`);
    console.log(`  query: ${h.query?.replace(/\s+/g, " ") || "(none)"}`);
  }

  const killable = holders.filter((h) => h.granted && h.state === SAFE_TO_KILL);
  const busy = holders.filter((h) => h.granted && h.state !== SAFE_TO_KILL);

  if (busy.length > 0) {
    console.log(
      `\n${busy.length} holder(s) are still doing something (${busy.map((h) => h.state ?? "?").join(", ")}).` +
        " Leaving those alone -- one of them may be a migration actually running.",
    );
  }

  if (killable.length === 0) {
    console.log("\nNothing safe to terminate.");
    await client.end();
    return;
  }

  if (!APPLY) {
    console.log(
      `\nDry run. Re-run with --apply to terminate ${killable.length} idle holder(s): ` +
        killable.map((h) => h.pid).join(", "),
    );
    await client.end();
    return;
  }

  for (const h of killable) {
    const { rows } = await client.query<{ ok: boolean }>("select pg_terminate_backend($1) as ok", [h.pid]);
    console.log(`\nterminated pid ${h.pid}: ${rows[0]?.ok ? "yes" : "no (already gone)"}`);
  }

  const { rows: left } = await client.query<{ n: string }>(
    "select count(*)::text as n from pg_locks where locktype = 'advisory' and objid = $1 and granted",
    [MIGRATE_ADVISORY_LOCK_ID],
  );
  console.log(`\nadvisory locks remaining: ${left[0]?.n ?? "?"}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
