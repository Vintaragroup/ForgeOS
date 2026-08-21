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

// Prisma 7 no longer reads DATABASE_URL from the schema's datasource block
// at runtime -- the client needs an explicit driver adapter. See
// prisma/schema.prisma's datasource comment and
// https://pris.ly/d/prisma7-client-config.
const adapter = new PrismaPg(pinSslMode(process.env.DATABASE_URL!));

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
