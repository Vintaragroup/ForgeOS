// Prisma CLI config (migrate/generate). The app itself connects through
// src/lib/db.ts -- this file only affects the CLI.
import "dotenv/config";
import { defineConfig } from "prisma/config";
import { directDatabaseUrl } from "./src/lib/direct-database-url";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Migrations must not run through the connection pooler -- see
  // src/lib/direct-database-url.ts for what happens when they do.
  datasource: {
    url: directDatabaseUrl(),
  },
});
