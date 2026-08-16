import { describe, expect, it } from "vitest";
import { buildStorageKey, deleteObject, getObject, putObject } from "@/lib/storage";

// @vercel/blob is mocked globally in src/test/setup.ts with an in-memory
// Map -- these exercise storage.ts's own logic (key sanitization, the
// put/get/delete round-trip, not-found behavior), not the real Vercel
// service.

describe("buildStorageKey", () => {
  it("scopes the key under the opportunity id and sanitizes the filename", () => {
    const key = buildStorageKey("opp-1", "My File (final v2).pdf");
    expect(key.startsWith("opp-1/")).toBe(true);

    // Everything after "opp-1/<uuid>-" should be the sanitized filename --
    // strip the UUID prefix rather than hand-encoding the exact dash count.
    const suffix = key.replace(/^opp-1\/[0-9a-f-]{36}-/, "");
    expect(suffix).toBe("My-File-final-v2-.pdf");
  });

  it("produces a different key each call, even for the same filename", () => {
    const a = buildStorageKey("opp-1", "same.pdf");
    const b = buildStorageKey("opp-1", "same.pdf");
    expect(a).not.toBe(b);
  });
});

describe("putObject / getObject / deleteObject", () => {
  it("round-trips bytes through the same storage key", async () => {
    const key = buildStorageKey("opp-2", "doc.pdf");
    const original = Buffer.from("hello vercel blob");

    await putObject(key, original);
    const fetched = await getObject(key);

    expect(fetched.equals(original)).toBe(true);
  });

  it("throws when getting a key that was never put", async () => {
    const key = buildStorageKey("opp-3", "missing.pdf");
    await expect(getObject(key)).rejects.toThrow(/not found/i);
  });

  it("deleteObject removes the bytes so a later get fails", async () => {
    const key = buildStorageKey("opp-4", "doc.pdf");
    await putObject(key, Buffer.from("bye"));

    await deleteObject(key);

    await expect(getObject(key)).rejects.toThrow(/not found/i);
  });
});
