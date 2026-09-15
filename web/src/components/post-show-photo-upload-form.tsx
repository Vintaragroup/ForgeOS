"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { Button } from "@/components/ui";

// Multi-file, image-only variant of ArtworkUploadForm -- damage
// documentation is realistically more than one photo (a torn corner AND
// a wide shot, say), so this follows DocumentUploadForm's multi-file
// pattern rather than ArtworkUploadForm's single-file one. storageKey is
// scoped under `${artworkOrderId}/post-show/` specifically -- the upload-
// token route enforces that same prefix, so this form's pathname
// construction and the route's own check have to stay in sync.
export function PostShowPhotoUploadForm({
  artworkOrderId,
  photoCount,
  finalizeUpload,
}: {
  artworkOrderId: string;
  // Current number of POST_SHOW_CONDITION_PHOTO files already on this
  // order -- seeds the round counter finalizeArtworkUpload's
  // systemAssignedFilename uses, so a second/third photo doesn't collide
  // on the same generic filename.
  photoCount: number;
  finalizeUpload: (data: { storageKey: string; filename: string; mimeType: string; sizeBytes: number; round: number }) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (uploading) return;
    setError(null);

    const files = Array.from(inputRef.current?.files ?? []).filter((f) => f.size > 0);
    if (files.length === 0) {
      setError("Choose at least one photo to upload.");
      return;
    }

    setUploading(true);
    try {
      let round = photoCount;
      for (const file of files) {
        round += 1;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const pathname = `${artworkOrderId}/post-show/${crypto.randomUUID()}-${safeName}`;
        const blob = await upload(pathname, file, {
          access: "private",
          handleUploadUrl: `/artwork/${artworkOrderId}/post-show-photo-upload-token`,
        });
        await finalizeUpload({
          storageKey: blob.pathname,
          filename: file.name,
          mimeType: file.type || "image/jpeg",
          sizeBytes: file.size,
          round,
        });
      }
      setFileNames([]);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-1.5 rounded-md border-2 border-dashed border-neutral-300 px-4 py-6 text-center">
        <p className="text-sm text-neutral-500">
          <button type="button" onClick={() => inputRef.current?.click()} className="font-medium text-brand-navy hover:underline">
            Choose photo(s)
          </button>
          {" "}— multiple at once is fine
        </p>
        {fileNames.length > 0 && (
          <p className="text-xs font-medium text-neutral-700">
            {fileNames.length === 1 ? fileNames[0] : `${fileNames.length} photos selected`}
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.heic,.webp"
          onChange={(e) => setFileNames(e.target.files ? Array.from(e.target.files).map((f) => f.name) : [])}
          className="hidden"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button disabled={uploading}>{uploading ? "Uploading…" : "Upload reference photo(s)"}</Button>
    </form>
  );
}
