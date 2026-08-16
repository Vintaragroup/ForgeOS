import { randomUUID } from "node:crypto";
import path from "node:path";
import { del, get, put } from "@vercel/blob";

// Vercel Blob-backed object storage -- access: "private" means blobs are
// only readable via an authenticated get() call with BLOB_READ_WRITE_TOKEN,
// never a bare public URL. Callers only ever see put/get/delete with an
// opaque storageKey; the raw blob URL must never be sent to the browser or
// embedded in a client-visible attribute -- every existing caller already
// only touches getObject's returned Buffer server-side (documents/[id]/route.ts
// and the /view page stream bytes through the app's own access-checked
// response), and this must stay true for any future caller too.

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// opportunityId scopes the blob pathname for easy manual inspection;
// randomUUID + the original filename avoids collisions without needing a
// DB round-trip first to get a Document id.
export function buildStorageKey(opportunityId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(opportunityId, `${randomUUID()}-${safeName}`);
}

export async function putObject(storageKey: string, bytes: Buffer): Promise<void> {
  await put(storageKey, bytes, { access: "private", token: BLOB_TOKEN });
}

export async function getObject(storageKey: string): Promise<Buffer> {
  const result = await get(storageKey, { access: "private", token: BLOB_TOKEN });
  if (!result || !result.stream) {
    throw new Error(`Storage object not found: ${storageKey}`);
  }
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function deleteObject(storageKey: string): Promise<void> {
  await del(storageKey, { token: BLOB_TOKEN });
}
