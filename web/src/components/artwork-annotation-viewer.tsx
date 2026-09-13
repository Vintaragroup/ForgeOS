"use client";

import { useRef, useState } from "react";
import type { ViewerAnnotation } from "@/lib/artwork-annotation-service";

// Pinned-point comments over a rasterized proof/approved-artwork image --
// absolutely-positioned DOM markers driven by percentage coordinates, not a
// real <canvas> or a drawing library. See this feature's own plan for why:
// pinned comments deliver the real "point at exactly where" value without
// needing a drawing toolkit, and this app already has real pointer-driven
// client components (cut-sheet-diagram-editor.tsx) -- this isn't a first,
// just one more focused component in an established pattern.
//
// canCreate/canResolve/anonymized are set once by each portal's own page
// (internal: create+resolve; client: create only; vendor: neither, plus
// anonymized -- see ArtworkAnnotation's own schema comment for why the
// vendor path never even receives author fields to begin with, this
// component only decides how to LABEL what it was given).
export function ArtworkAnnotationViewer({
  imageDataUrl,
  annotations,
  canCreate,
  canResolve,
  anonymized,
  artworkFileId,
  createAction,
  resolveAction,
}: {
  imageDataUrl: string;
  annotations: ViewerAnnotation[];
  canCreate: boolean;
  canResolve: boolean;
  anonymized: boolean;
  artworkFileId: string;
  createAction?: (formData: FormData) => void;
  resolveAction?: (formData: FormData) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [pendingPin, setPendingPin] = useState<{ xPct: number; yPct: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const authorLabel = (a: ViewerAnnotation) => {
    if (anonymized || !a.authorType) return "Expo review note";
    return a.authorType === "CLIENT" ? "Client" : "Expo";
  };

  return (
    <div className="relative inline-block max-w-full">
      <div
        className="relative"
        onClick={(e) => {
          if (!canCreate || !imgRef.current) return;
          // Ignore clicks on an existing marker (they open their own popover
          // via stopPropagation below) -- only a click on empty image area
          // starts a new pin.
          const rect = imgRef.current.getBoundingClientRect();
          const xPct = (e.clientX - rect.left) / rect.width;
          const yPct = (e.clientY - rect.top) / rect.height;
          setSelectedId(null);
          setPendingPin({ xPct: Math.min(1, Math.max(0, xPct)), yPct: Math.min(1, Math.max(0, yPct)) });
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a live-generated data: URL, not an optimizable static asset */}
        <img
          ref={imgRef}
          src={imageDataUrl}
          alt="Artwork proof"
          className="block max-w-full rounded-md border border-neutral-200"
          style={{ cursor: canCreate ? "crosshair" : "default" }}
        />

        {annotations.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPendingPin(null);
              setSelectedId(selectedId === a.id ? null : a.id);
            }}
            className={`absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white shadow ${
              a.resolvedAt ? "bg-neutral-400" : "bg-red-600"
            }`}
            style={{ left: `${a.xPct * 100}%`, top: `${a.yPct * 100}%` }}
            aria-label={`Pin ${i + 1}${a.resolvedAt ? " (resolved)" : ""}`}
          >
            {i + 1}
          </button>
        ))}

        {pendingPin && (
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-neutral-900 shadow"
            style={{ left: `${pendingPin.xPct * 100}%`, top: `${pendingPin.yPct * 100}%`, width: 12, height: 12 }}
          />
        )}
      </div>

      {pendingPin && createAction && (
        <div className="mt-3 rounded-md border border-neutral-300 bg-white p-3 shadow-sm">
          <form
            action={createAction}
            onSubmit={() => setPendingPin(null)}
            className="flex flex-col gap-2"
          >
            <input type="hidden" name="artworkFileId" value={artworkFileId} />
            <input type="hidden" name="xPct" value={pendingPin.xPct} />
            <input type="hidden" name="yPct" value={pendingPin.yPct} />
            <label htmlFor="note" className="text-sm font-medium text-neutral-700">
              New pinned note
            </label>
            <textarea
              id="note"
              name="note"
              required
              rows={2}
              autoFocus
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500"
            />
            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-navy">
                Add pin
              </button>
              <button
                type="button"
                onClick={() => setPendingPin(null)}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {selectedId &&
        (() => {
          const selected = annotations.find((a) => a.id === selectedId);
          if (!selected) return null;
          const index = annotations.findIndex((a) => a.id === selectedId);
          return (
            <div className="mt-3 rounded-md border border-neutral-300 bg-white p-3 shadow-sm">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Pin {index + 1} — {authorLabel(selected)}
                {selected.resolvedAt && " · resolved"}
              </p>
              <p className="mb-2 text-sm text-neutral-800">{selected.note}</p>
              {canResolve && !selected.resolvedAt && resolveAction && (
                <form action={resolveAction} onSubmit={() => setSelectedId(null)}>
                  <input type="hidden" name="annotationId" value={selected.id} />
                  <button type="submit" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
                    Mark resolved
                  </button>
                </form>
              )}
            </div>
          );
        })()}
    </div>
  );
}
