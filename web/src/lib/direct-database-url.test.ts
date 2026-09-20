import { describe, expect, it } from "vitest";
import { directDatabaseUrl, withDirectPort } from "@/lib/direct-database-url";

const POOLED = "postgresql://forgeos_user:secret@dpg-abc-a.virginia-postgres.render.com:6432/forgeos?sslmode=require";
const DIRECT = "postgresql://forgeos_user:secret@dpg-abc-a.virginia-postgres.render.com:5432/forgeos?sslmode=require";

describe("withDirectPort", () => {
  it("swaps the pooler port for the direct one, leaving the rest alone", () => {
    expect(withDirectPort(POOLED)).toBe(DIRECT);
  });

  it("leaves a URL that is already direct untouched", () => {
    expect(withDirectPort(DIRECT)).toBe(DIRECT);
  });

  it("leaves a URL with no port untouched (local dev)", () => {
    const local = "postgresql://ryan@localhost/forgeos_dev";
    expect(withDirectPort(local)).toBe(local);
  });

  it("does not mistake 6432 inside the password for the port", () => {
    const url = "postgresql://user:pw6432@host:5432/forgeos";
    expect(withDirectPort(url)).toBe(url);
  });

  it("does not mistake 6432 inside the database name for the port", () => {
    const url = "postgresql://user:pw@host/db6432";
    expect(withDirectPort(url)).toBe(url);
  });

  it("finds the host when the password contains an @", () => {
    expect(withDirectPort("postgresql://user:p@ss@host:6432/db")).toBe("postgresql://user:p@ss@host:5432/db");
  });

  it("handles a bracketed IPv6 host", () => {
    expect(withDirectPort("postgresql://user:pw@[::1]:6432/db")).toBe("postgresql://user:pw@[::1]:5432/db");
  });

  it("handles a URL with no path", () => {
    expect(withDirectPort("postgresql://user:pw@host:6432")).toBe("postgresql://user:pw@host:5432");
  });

  it("hands back something that isn't a URL rather than throwing", () => {
    expect(withDirectPort("not a connection string")).toBe("not a connection string");
  });
});

describe("directDatabaseUrl", () => {
  it("prefers DIRECT_DATABASE_URL when it is set", () => {
    const explicit = "postgresql://user:pw@other-host:5432/forgeos";
    expect(directDatabaseUrl({ DIRECT_DATABASE_URL: explicit, DATABASE_URL: POOLED })).toBe(explicit);
  });

  it("falls back to depooling DATABASE_URL", () => {
    expect(directDatabaseUrl({ DATABASE_URL: POOLED })).toBe(DIRECT);
  });

  it("ignores an empty DIRECT_DATABASE_URL", () => {
    expect(directDatabaseUrl({ DIRECT_DATABASE_URL: "", DATABASE_URL: POOLED })).toBe(DIRECT);
  });

  it("returns undefined when nothing is set", () => {
    expect(directDatabaseUrl({})).toBeUndefined();
  });
});
