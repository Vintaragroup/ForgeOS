"use client";

import { useRef, useState } from "react";
import { Button, SelectField } from "@/components/ui";

// The fourth client component in this app -- native <input type="file">
// has no drop target of its own, so dragging a whole RFP folder in
// (rather than one file at a time via the OS picker) needs a real
// dragenter/dragover/drop handler. The actual upload is still a plain
// Server Action form post underneath; this only manages what's in the
// file input before submit.
export function DocumentUploadForm({
  action,
  documentTypeOptions,
}: {
  action: (formData: FormData) => void | Promise<void>;
  documentTypeOptions: { value: string; label: string }[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileNames, setFileNames] = useState<string[]>([]);

  function handleFiles(files: FileList) {
    if (inputRef.current) inputRef.current.files = files;
    setFileNames(Array.from(files).map((f) => f.name));
  }

  return (
    <form action={action} className="border-t border-neutral-200 pt-4">
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
          accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt"
          onChange={(e) => setFileNames(e.target.files ? Array.from(e.target.files).map((f) => f.name) : [])}
          className="hidden"
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <SelectField label="Type" name="documentType" defaultValue="OTHER" options={documentTypeOptions} />
        </div>
        <Button>Upload</Button>
      </div>
    </form>
  );
}
