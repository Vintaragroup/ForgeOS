import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// pg-connection-string currently treats sslmode=prefer/require/verify-ca as
// aliases for verify-full (full certificate + hostname verification) --
// which is why a Render connection string using sslmode=require is already
// getting strict verification today. It also emits a deprecation warning:
// the next major version of pg/pg-connection-string reverts these to real
// libpq semantics, where "require" only encrypts without verifying anything
// -- a silent security downgrade on upgrade day if nothing here changes.
// Rewriting to the explicit, unambiguous mode locks in today's actual
// (already-verified-working) behavior permanently, without needing to
// touch the DATABASE_URL secret itself.
const DEPRECATED_SSL_MODES = new Set(["prefer", "require", "verify-ca"]);

function pinSslMode(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode && DEPRECATED_SSL_MODES.has(sslmode)) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

// Local Postgres (dev/test, always localhost/127.0.0.1) has no SSL listener
// at all -- forcing ssl below unconditionally would break every local `npm
// test`/`npm run dev` run. Only a real remote host (Render in every
// environment that matters here) gets SSL forced.
function isLocalHost(databaseUrl: string): boolean {
  const { hostname } = new URL(databaseUrl);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

// Prisma 7 no longer reads DATABASE_URL from the schema's datasource block
// at runtime -- the client needs an explicit driver adapter. See
// prisma/schema.prisma's datasource comment and
// https://pris.ly/d/prisma7-client-config.
//
// SSL is forced explicitly via `ssl`, not left to the connection string's
// own `sslmode` query param -- a real 2026-09-12 incident found that
// relying on the URL string alone was fragile (Render started rejecting
// plaintext connections, apparently after the account's connection pooler
// was toggled on, and the string-based sslmode fix didn't reliably take
// effect through several redeploys). Passing a real pg.PoolConfig object
// makes SSL non-negotiable at the driver level regardless of what's in the
// URL, and isn't subject to hand-editing mistakes in a hidden/sensitive
// dashboard field the way a query-string edit is.
const rawDatabaseUrl = process.env.DATABASE_URL!;
const adapter = new PrismaPg({
  connectionString: pinSslMode(rawDatabaseUrl),
  ...(isLocalHost(rawDatabaseUrl) ? {} : { ssl: { rejectUnauthorized: true } }),
});

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
