"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { Button } from "@/components/ui";

// Shared by both the Client Portal (uploading artwork) and Vendor Portal
// (uploading a proof) -- same direct-to-Blob pattern as
// document-upload-form.tsx, just single-file and PDF/AI-only, per the
// artwork pipeline's narrower accepted set (wireframe 6.3/6.9).
export function ArtworkUploadForm({
  artworkOrderId,
  uploadTokenUrl,
  finalizeUpload,
  submitLabel = "Upload",
  accept = ".pdf,.ai",
}: {
  artworkOrderId: string;
  uploadTokenUrl: string;
  finalizeUpload: (data: { storageKey: string; filename: string; mimeType: string; sizeBytes: number }) => Promise<void>;
  submitLabel?: string;
  accept?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (uploading) return;
    setError(null);

    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file to upload.");
      return;
    }

    setUploading(true);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const pathname = `${artworkOrderId}/${crypto.randomUUID()}-${safeName}`;
      const blob = await upload(pathname, file, { access: "private", handleUploadUrl: uploadTokenUrl });
      await finalizeUpload({ storageKey: blob.pathname, filename: file.name, mimeType: file.type || "application/pdf", sizeBytes: file.size });
      setFileName(null);
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
            Choose a file
          </button>
          {" "}— accepted: PDF, AI
        </p>
        {fileName && <p className="text-xs font-medium text-neutral-700">{fileName}</p>}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          required
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          className="hidden"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button disabled={uploading}>{uploading ? "Uploading…" : submitLabel}</Button>
    </form>
  );
}
