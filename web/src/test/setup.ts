// Points the test run at forgeos_test, never forgeos_dev -- must load
// before anything imports src/lib/db.ts, which reads DATABASE_URL at
// module-init time.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(__dirname, "../../.env.test") });

if (!process.env.DATABASE_URL?.includes("forgeos_test")) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not point at forgeos_test (got ${process.env.DATABASE_URL}). ` +
      "Tests truncate tables between runs -- never point this at forgeos_dev.",
  );
}
