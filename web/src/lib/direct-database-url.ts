// Which connection string to use when a pooler is the wrong place to connect.
//
// The app talks to Postgres through Render's pooler (port 6432), which is
// right for request traffic. Migrations are not request traffic:
// `prisma migrate deploy` takes a session-level advisory lock
// (pg_advisory_lock) so two deploys can't migrate at once. Through the
// pooler that lock lands on a pooled *server* connection that outlives the
// migrate process and is then handed back out to ordinary app queries --
// so nothing ever unlocks it, and the next deploy dies with P1002
// "Timed out trying to acquire a postgres advisory lock". That's what
// killed the 2026-09-20 production build: the lock's holder was an idle
// session whose last statement was an app read of client_touches.
//
// So anything taking a session-level lock connects directly instead.

const POOLER_PORT = "6432";
const DIRECT_PORT = "5432";

// The port is rewritten by hand rather than through `new URL`: a password
// containing `/` or `@` makes the URL unparseable even though Postgres
// accepts the string, and a throw here would be a confusing way to learn
// that. Only the authority's host:port is touched -- the part after the
// last `@` and before the path.
export function withDirectPort(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return url;
  const authorityStart = schemeEnd + 3;
  const relativeEnd = url.slice(authorityStart).search(/[/?#]/);
  const cut = relativeEnd < 0 ? url.length : authorityStart + relativeEnd;
  const authority = url.slice(authorityStart, cut);

  const hostStart = authority.lastIndexOf("@") + 1;
  const hostPort = authority.slice(hostStart);
  if (!hostPort.endsWith(`:${POOLER_PORT}`)) return url;

  const direct = hostPort.slice(0, -POOLER_PORT.length) + DIRECT_PORT;
  return url.slice(0, authorityStart) + authority.slice(0, hostStart) + direct + url.slice(cut);
}

// DIRECT_DATABASE_URL wins when it's set -- a host whose direct endpoint
// isn't just "same host, other port" needs to say so explicitly.
// Otherwise the pooler port is rewritten, so an existing DATABASE_URL
// keeps working untouched, and a URL that was never pooled (local dev)
// passes straight through.
export function directDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const explicit = env["DIRECT_DATABASE_URL"];
  if (explicit) return explicit;
  const url = env["DATABASE_URL"];
  return url ? withDirectPort(url) : undefined;
}

// The lock `prisma migrate deploy` takes. Prisma derives it from the
// schema; it has been this value for every migration this app has run,
// and scripts/clear-migrate-lock.ts checks the live value against the
// build log rather than trusting it blindly.
export const MIGRATE_ADVISORY_LOCK_ID = 72707369;
