"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { Button, SelectField } from "@/components/ui";

// The fourth client component in this app -- native <input type="file">
// has no drop target of its own, so dragging a whole RFP folder in
// (rather than one file at a time via the OS picker) needs a real
// dragenter/dragover/drop handler.
//
// The actual upload used to be a plain Server Action form post, with the
// file's bytes riding inside the action's own request body. That silently
// broke on a real (if unremarkable) upload -- 6 files totaling 7.2MB, well
// under next.config.ts's 40MB serverActions.bodySizeLimit -- because
// Vercel Functions enforce their own request-body ceiling ahead of
// whatever that config promises, and rejected the request before this
// app's server code ever ran (no server-side log line at all for the
// failed request is what gave that away). @vercel/blob/client's upload()
// instead sends each file straight from the browser to Blob storage;
// upload-token/route.ts only ever hands out a short-lived, opportunity-
// scoped token, never touches the file's bytes, and finalizeUploadAction
// only ever receives the small JSON description of what already landed in
// Blob -- so there's no request body left for any platform ceiling to
// reject.
export function DocumentUploadForm({
  opportunityId,
  finalizeUpload,
  documentTypeOptions,
}: {
  opportunityId: string;
  finalizeUpload: (
    opportunityId: string,
    data: { storageKey: string; filename: string; documentType: string },
  ) => Promise<void>;
  documentTypeOptions: { value: string; label: string }[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFiles(files: FileList) {
    if (inputRef.current) inputRef.current.files = files;
    setFileNames(Array.from(files).map((f) => f.name));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (uploading) return; // Button has no disabled prop to guard a double-click with.
    setError(null);

    const files = Array.from(inputRef.current?.files ?? []).filter((f) => f.size > 0);
    if (files.length === 0) {
      setError("Choose at least one file to upload.");
      return;
    }
    const documentType = new FormData(e.currentTarget).get("documentType");

    setUploading(true);
    try {
      // One at a time, not Promise.all -- a large batch shouldn't try to
      // push every file to Blob concurrently, and a mid-batch failure
      // should leave the earlier files already uploaded and recorded
      // rather than all-or-nothing, same posture the old version had.
      for (const file of files) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const pathname = `${opportunityId}/${crypto.randomUUID()}-${safeName}`;
        const blob = await upload(pathname, file, {
          access: "private",
          handleUploadUrl: `/opportunities/${opportunityId}/documents/upload-token`,
        });
        await finalizeUpload(opportunityId, {
          storageKey: blob.pathname,
          filename: file.name,
          documentType: String(documentType ?? "OTHER"),
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
    <form onSubmit={handleSubmit} className="border-t border-neutral-200 pt-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        }}
        className={`mb-3 flex flex-col items-center gap-1.5 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? "border-brand-teal bg-brand-teal-pale/40" : "border-neutral-300"
        }`}
      >
        <p className="text-sm text-neutral-500">
          Drag files here, or{" "}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="font-medium text-brand-navy hover:underline"
          >
            browse
          </button>
          {" "}— multiple at once is fine, they all get the Type below.
        </p>
        {fileNames.length > 0 && (
          <p className="text-xs font-medium text-neutral-700">
            {fileNames.length === 1 ? fileNames[0] : `${fileNames.length} files selected`}
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          name="file"
          multiple
          required
          accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.md,.markdown"
          onChange={(e) => setFileNames(e.target.files ? Array.from(e.target.files).map((f) => f.name) : [])}
          className="hidden"
        />
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <SelectField label="Type" name="documentType" defaultValue="OTHER" options={documentTypeOptions} />
        </div>
        <Button>{uploading ? "Uploading…" : "Upload"}</Button>
      </div>
    </form>
  );
}
