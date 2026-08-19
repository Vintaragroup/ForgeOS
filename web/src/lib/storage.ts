import { randomUUID } from "node:crypto";
import path from "node:path";
import { del, get, head, put } from "@vercel/blob";

// Vercel Blob-backed object storage -- access: "private" means blobs are
// only readable via an authenticated get() call, never a bare public URL.
// Callers only ever see put/get/delete with an opaque storageKey; the raw
// blob URL must never be sent to the browser or embedded in a
// client-visible attribute -- every existing caller already only touches
// getObject's returned Buffer server-side (documents/[id]/route.ts and the
// /view page stream bytes through the app's own access-checked response),
// and this must stay true for any future caller too.
//
// No token/storeId is passed to put/get/del below -- the SDK auto-resolves
// credentials from the environment (VERCEL_OIDC_TOKEN + BLOB_STORE_ID when
// the project's Blob store is connected via the dashboard, which is how
// this app is set up; BLOB_READ_WRITE_TOKEN as a fallback otherwise), so
// this file doesn't need to know or care which auth mode is active.

// opportunityId scopes the blob pathname for easy manual inspection;
// randomUUID + the original filename avoids collisions without needing a
// DB round-trip first to get a Document id.
export function buildStorageKey(opportunityId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(opportunityId, `${randomUUID()}-${safeName}`);
}

export async function putObject(storageKey: string, bytes: Buffer): Promise<void> {
  await put(storageKey, bytes, { access: "private" });
}

export async function getObject(storageKey: string): Promise<Buffer> {
  const result = await get(storageKey, { access: "private" });
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
  await del(storageKey);
}

// For documents uploaded directly from the browser to Blob (bypassing the
// app server entirely, to get around Vercel Functions' own request-body
// ceiling -- see documents/upload/route.ts), rather than through putObject
// above. The client chooses access:"private" itself when it calls the Blob
// client SDK's upload(), but nothing server-side can constrain that choice
// at token-issuance time -- Vercel Blob's client-token protocol doesn't
// expose `access` to onBeforeGenerateToken at all, so a modified client
// could request access:"public" instead and this file would have no way to
// stop it up front. This is the one place every such upload passes through
// before its Document row is created, so it's where that gets verified: a
// plain, unauthenticated fetch of the blob's own URL must NOT succeed. If
// it does, the blob is deleted and the upload is rejected outright, rather
// than trusting the client's own claim about its access level.
export async function headPrivateObject(storageKey: string): Promise<{ size: number; contentType: string }> {
  const meta = await head(storageKey);
  const publicProbe = await fetch(meta.url);
  if (publicProbe.ok) {
    await del(storageKey);
    throw new Error("Upload rejected: the stored file was not private.");
  }
  return { size: meta.size, contentType: meta.contentType };
}
