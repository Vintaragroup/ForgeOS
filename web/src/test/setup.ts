// Points the test run at forgeos_test, never forgeos_dev -- must load
// before anything imports src/lib/db.ts, which reads DATABASE_URL at
// module-init time.
import { config } from "dotenv";
import path from "node:path";
import { vi } from "vitest";

config({ path: path.resolve(__dirname, "../../.env.test") });

if (!process.env.DATABASE_URL?.includes("forgeos_test")) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not point at forgeos_test (got ${process.env.DATABASE_URL}). ` +
      "Tests truncate tables between runs -- never point this at forgeos_dev.",
  );
}

// No BLOB_READ_WRITE_TOKEN in test/CI env (same posture as OPENAI_API_KEY
// being deliberately unset) -- fake the storage.ts <-> @vercel/blob
// boundary with an in-memory Map so document-service.test.ts's real
// upload/download round-trips keep working without hitting the network.
vi.mock("@vercel/blob", () => {
  const store = new Map<string, Buffer>();
  return {
    put: vi.fn(async (pathname: string, body: Buffer) => {
      store.set(pathname, Buffer.from(body));
      return { url: `mock://blob/${pathname}`, pathname };
    }),
    get: vi.fn(async (pathname: string) => {
      const bytes = store.get(pathname);
      if (!bytes) return null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
      return {
        statusCode: 200,
        stream,
        headers: new Headers(),
        blob: { contentType: "application/octet-stream", size: bytes.length },
      };
    }),
    del: vi.fn(async (pathname: string | string[]) => {
      for (const key of Array.isArray(pathname) ? pathname : [pathname]) store.delete(key);
    }),
  };
});
