"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { BRAND } from "@/lib/brand";
import { noOverlap, type PlacedPart } from "@/lib/cut-sheet-geometry";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";
import {
  updateCutSheetLayoutAction,
  toggleCutSheetLockAction,
  toggleCutSheetCutAction,
} from "@/app/(app)/estimates/[id]/versions/[versionId]/cut-list/actions";

// Cut-list phase 6, feature 5: drag-to-reposition editing of an already-
// packed layout. Same per-sheet scale/labelFontSize math as
// cut-sheet-diagram.tsx (Feature 4's read-only version, still used on the
// Project page and for a locked version -- editing never applies there),
// with pointer-drag state and live overlap/bounds validation layered on
// top. Only ever rendered when the version is unlocked (cut-list/page.tsx
// gates this the same way it gates every other mutating control).
//
// Smart guides + shift-drag (both added after the initial drag build):
// grid-snap (gridSnap prop, from CutListSettings.dragGridSnap -- a
// shop-configurable value, see catalog/cut-list-settings) is the
// default, but a drag that lands within SNAP_PIXELS of another part's or
// the sheet's own edge/center overrides it and draws a guide line -- see
// computeAlignedPosition. "Snap to corner" isn't a separate feature;
// it's just both axes matching a guide at once. Holding Shift while
// dragging constrains movement to whichever axis has moved further,
// matching Figma/PowerPoint's own convention.
const DIAGRAM_MAX_WIDTH = 500;
const DIAGRAM_MAX_HEIGHT = 380;
// A screen-pixel (not inch) threshold -- alignment "feel" should stay
// consistent regardless of a sheet's real size, so this is converted to
// inches via the current scale, not a fixed inch value that would feel
// twitchy on a small remnant and unreachable on a full 48x96 sheet.
const SNAP_PIXELS = 6;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function snap(n: number, gridSnap: number): number {
  return Math.round(n / gridSnap) * gridSnap;
}

export interface Guide {
  axis: "x" | "y";
  position: number;
}

// One axis's worth of smart-guide matching: compares the dragged part's
// own start/center/end against every candidate reference line, and (if
// one is within threshold) returns both the resulting START coordinate
// for that part AND the matched reference line itself, in one pass --
// deriving them separately (as an earlier draft of this function did)
// requires the two searches to agree, which is a real, avoidable way for
// the guide line drawn on screen to silently mismatch the actual snapped
// position.
function bestAxisSnap(start: number, size: number, refs: number[], thresholdIn: number): { start: number; guide: number } | null {
  let best: { delta: number; start: number; guide: number } | null = null;
  for (const offset of [0, size / 2, size]) {
    const edge = start + offset;
    for (const ref of refs) {
      const delta = Math.abs(edge - ref);
      if (delta <= thresholdIn && (!best || delta < best.delta)) {
        best = { delta, start: ref - offset, guide: ref };
      }
    }
  }
  return best ? { start: best.start, guide: best.guide } : null;
}

// Figma/PowerPoint-style smart guides: the dragged part's own left/
// center/right (and top/center/bottom) edges are compared against every
// OTHER part's matching edges plus the sheet's own bounds/center -- a
// match within threshold overrides the plain grid-snap for that axis.
// Two independent single-axis searches, not a combined one -- "snap to
// corner" is just what happens when both axes happen to match at once,
// not a separate code path.
export function computeAlignedPosition(
  candidateX: number,
  candidateY: number,
  width: number,
  height: number,
  otherParts: PlacedPart[],
  sheetWidth: number,
  sheetLength: number,
  thresholdIn: number,
  gridSnap: number,
): { x: number; y: number; guides: Guide[] } {
  const refX = [0, sheetWidth / 2, sheetWidth];
  const refY = [0, sheetLength / 2, sheetLength];
  for (const p of otherParts) {
    refX.push(p.x, p.x + p.width / 2, p.x + p.width);
    refY.push(p.y, p.y + p.height / 2, p.y + p.height);
  }

  const guides: Guide[] = [];
  const xSnap = bestAxisSnap(candidateX, width, refX, thresholdIn);
  const x = xSnap ? xSnap.start : snap(candidateX, gridSnap);
  if (xSnap) guides.push({ axis: "x", position: xSnap.guide });

  const ySnap = bestAxisSnap(candidateY, height, refY, thresholdIn);
  const y = ySnap ? ySnap.start : snap(candidateY, gridSnap);
  if (ySnap) guides.push({ axis: "y", position: ySnap.guide });

  return { x, y, guides };
}

export function CutSheetDiagramEditor({
  estimateId,
  versionId,
  materialId,
  sheet,
  sheetCount,
  gridSnap,
}: {
  estimateId: string;
  versionId: string;
  materialId: string;
  sheet: CutSheetDiagramData["sheets"][number];
  sheetCount: number;
  // CutListSettings.dragGridSnap -- a shop-configurable value (see
  // catalog/cut-list-settings), fetched server-side by cut-list/page.tsx
  // and passed down rather than read directly here (this is a client
  // component; DB access stays server-side).
  gridSnap: number;
}) {
  const [parts, setParts] = useState<PlacedPart[]>(sheet.parts);
  // The last successfully-saved (or initial) layout -- what "dirty"
  // compares against. Not the same as the sheet.parts prop: a Server
  // Action invoked directly (not via <form action>) has no guaranteed
  // synchronous re-render of this component with fresh server props just
  // because it calls revalidatePath, so "saved successfully" is tracked
  // here explicitly rather than assumed from a prop that may not have
  // actually refreshed yet.
  const [baseline, setBaseline] = useState<PlacedPart[]>(sheet.parts);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Pointer-space (client px) origin + the dragged part's own start
  // position AND which part is being dragged, all in one ref -- a real,
  // confirmed-live bug in an earlier version of this component read the
  // dragged index from React state (dragIndex) inside handlePointerMove,
  // whose closure can still see the PRE-drag value (null) if a pointermove
  // event arrives before React has flushed the setDragIndex update from
  // pointerdown (plausible for a fast real drag, not just a synthetic
  // test) -- the very first move of a drag would silently do nothing. A
  // ref update is synchronously visible the instant it's assigned,
  // regardless of React's render/commit timing, so the pointer handlers
  // read the drag target from here, never from state.
  const dragOrigin = useRef<{ index: number; pointerX: number; pointerY: number; partX: number; partY: number } | null>(null);
  // Guides currently drawn during an active drag -- real React state
  // (not folded into the ref above) because it needs to trigger a
  // re-render on its own to actually show up, but it's only ever set
  // alongside setParts inside the same handlePointerMove call, so both
  // land in the same React 18+ batched re-render.
  const [activeGuides, setActiveGuides] = useState<Guide[]>([]);
  const [zoom, setZoom] = useState(1);
  // The scrollable viewport around the SVG -- zooming in grows the SVG's
  // rendered size past this container's fixed max, so the browser's own
  // scrollbars (native, no custom pan logic needed) let the user get to
  // the rest of it. Also where the non-passive wheel listener attaches
  // (see the effect below for why that can't just be onWheel).
  const viewportRef = useRef<HTMLDivElement>(null);

  const scale = Math.min(DIAGRAM_MAX_WIDTH / sheet.width, DIAGRAM_MAX_HEIGHT / sheet.length) * zoom;
  const svgWidth = sheet.width * scale;
  const svgHeight = sheet.length * scale;
  const labelFontSize = Math.max(Math.min(sheet.width, sheet.length) * 0.018, 0.15);

  // Ctrl/Cmd+scroll to zoom (trackpad pinch-zoom also reports ctrlKey:
  // true on wheel events, so this covers both) -- a plain scroll is left
  // alone so it still scrolls the page/container normally, matching the
  // same modifier convention Figma and Google Maps use. Attached as a
  // real DOM listener with { passive: false }, not the JSX onWheel prop:
  // React's synthetic wheel handler doesn't reliably let
  // preventDefault() suppress the browser's own native zoom/scroll on
  // every browser, and this needs to actually win that race.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // Scoped to this diagram's own container (tabIndex + onKeyDown below),
  // not a global window listener -- a version can show several sheets
  // at once, and a global listener would fire for all of them regardless
  // of which one the user actually meant, or hijack keystrokes while
  // typing in the Add-a-part form elsewhere on the page.
  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setZoom((z) => clampZoom(z + ZOOM_STEP));
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      setZoom((z) => clampZoom(z - ZOOM_STEP));
    } else if (e.key === "0") {
      e.preventDefault();
      setZoom(1);
    }
  }

  const dirty = parts.some((p, i) => p.x !== baseline[i].x || p.y !== baseline[i].y);

  function outOfBounds(p: PlacedPart): boolean {
    return p.x < 0 || p.y < 0 || p.x + p.width > sheet.width || p.y + p.height > sheet.length;
  }
  const invalidIndexes = new Set(
    parts
      .map((p, i) => (outOfBounds(p) || parts.some((other, j) => j !== i && !noOverlap(p, other)) ? i : -1))
      .filter((i) => i >= 0),
  );
  const valid = invalidIndexes.size === 0;

  function handlePointerDown(e: ReactPointerEvent<SVGRectElement>, index: number) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragOrigin.current = { index, pointerX: e.clientX, pointerY: e.clientY, partX: parts[index].x, partY: parts[index].y };
  }

  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const origin = dragOrigin.current;
    if (!origin) return;
    let deltaXIn = (e.clientX - origin.pointerX) / scale;
    let deltaYIn = (e.clientY - origin.pointerY) / scale;

    // Shift-drag: constrain to whichever axis has moved further from the
    // drag's start, holding the other axis exactly at its starting value
    // -- same constrain-drag convention as Figma/PowerPoint. The locked
    // axis still isn't free to alignment-snap or grid-snap away from
    // where the drag started; it just doesn't move at all.
    if (e.shiftKey) {
      if (Math.abs(deltaXIn) >= Math.abs(deltaYIn)) deltaYIn = 0;
      else deltaXIn = 0;
    }

    const candidateX = origin.partX + deltaXIn;
    const candidateY = origin.partY + deltaYIn;
    const draggedPart = parts[origin.index];
    const otherParts = parts.filter((_, i) => i !== origin.index);
    const thresholdIn = SNAP_PIXELS / scale;
    const { x, y, guides } = computeAlignedPosition(
      candidateX,
      candidateY,
      draggedPart.width,
      draggedPart.height,
      otherParts,
      sheet.width,
      sheet.length,
      thresholdIn,
      gridSnap,
    );

    setParts((prev) => prev.map((p, i) => (i === origin.index ? { ...p, x, y } : p)));
    setActiveGuides(guides);
  }

  function handlePointerUp() {
    dragOrigin.current = null;
    setActiveGuides([]);
  }

  function handleReset() {
    setParts(baseline);
    setError(null);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      try {
        await updateCutSheetLayoutAction(estimateId, versionId, materialId, sheet.sheetNumber, parts);
        setBaseline(parts);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save the layout.");
      }
    });
  }

  // Phase 8: plain <form action> toggles, same pattern cut-sheet-
  // diagram.tsx uses -- form actions work fine inside a client component
  // too, no need for onClick/startTransition just because this component
  // already uses those elsewhere for the drag-save flow. This component
  // only ever renders when BOTH the version and this sheet are unlocked
  // (see cut-list/page.tsx's render branch), so there's no "Unlock"
  // case to handle here -- locking flips this sheet over to the
  // read-only CutSheetDiagram on the next render.
  const toggleLockWithIds = toggleCutSheetLockAction.bind(null, estimateId, versionId, materialId, sheet.sheetNumber);
  const toggleCutWithIds = toggleCutSheetCutAction.bind(null, estimateId, versionId, materialId, sheet.sheetNumber);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex w-full items-center justify-between text-xs text-neutral-500">
        <span>
          Sheet {sheet.sheetNumber} of {sheetCount}
          {sheet.isRemnant && <span className="ml-2 font-semibold uppercase tracking-wide text-brand-tangerine">Remnant</span>}
        </span>
        <span className="flex items-center gap-3">
          Stock: {sheet.width}&quot; x {sheet.length}&quot;
          <form action={toggleLockWithIds}>
            <button type="submit" className="rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-50">
              Lock
            </button>
          </form>
          <form action={toggleCutWithIds}>
            <button
              type="submit"
              className={`rounded border px-2 py-0.5 hover:bg-neutral-50 ${sheet.cutAt ? "border-green-300 text-green-700" : "border-neutral-300"}`}
            >
              {sheet.cutAt ? `Cut ✓ ${new Date(sheet.cutAt).toLocaleDateString()}` : "Mark cut"}
            </button>
          </form>
        </span>
      </div>
      <div
        ref={viewportRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="max-w-full overflow-auto rounded-sm border border-neutral-300 outline-none focus-visible:ring-2 focus-visible:ring-brand-teal"
        style={{ maxWidth: DIAGRAM_MAX_WIDTH, maxHeight: DIAGRAM_MAX_HEIGHT }}
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${sheet.width} ${sheet.length}`}
          className="touch-none bg-white select-none"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
        <rect x={0} y={0} width={sheet.width} height={sheet.length} fill="#ffffff" stroke={BRAND.black} strokeWidth={0.05} />
        {parts.map((part, i) => {
          const canLabel = part.width > labelFontSize * 5 && part.height > labelFontSize * 2.5;
          const isInvalid = invalidIndexes.has(i);
          return (
            <g key={i}>
              <rect
                x={part.x}
                y={part.y}
                width={part.width}
                height={part.height}
                fill={isInvalid ? "#fde2e2" : BRAND.tealPale}
                stroke={isInvalid ? "#dc2626" : BRAND.teal}
                strokeWidth={0.03}
                className="cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => handlePointerDown(e, i)}
              />
              <text x={part.x + labelFontSize * 0.3} y={part.y + labelFontSize * 1.1} fontSize={labelFontSize} fill={BRAND.black}>
                {i + 1}
              </text>
              {canLabel && (
                <text
                  x={part.x + labelFontSize * 0.3}
                  y={part.y + labelFontSize * 2.3}
                  fontSize={labelFontSize * 0.7}
                  fill={BRAND.black}
                >
                  {`${part.width.toFixed(1)}x${part.height.toFixed(1)}${part.rotated ? " (rot)" : ""}`}
                </text>
              )}
            </g>
          );
        })}
        {/* Smart guides -- drawn last so they render on top of every part,
            same as every design tool's own alignment-guide layering. Only
            present while actively dragging (handlePointerUp clears them). */}
        {activeGuides.map((g, i) =>
          g.axis === "x" ? (
            <line
              key={i}
              x1={g.position}
              y1={0}
              x2={g.position}
              y2={sheet.length}
              stroke="#ec4899"
              strokeWidth={0.04}
              strokeDasharray="0.3,0.3"
            />
          ) : (
            <line
              key={i}
              x1={0}
              y1={g.position}
              x2={sheet.width}
              y2={g.position}
              stroke="#ec4899"
              strokeWidth={0.04}
              strokeDasharray="0.3,0.3"
            />
          ),
        )}
        </svg>
      </div>
      <div className="flex w-full items-center justify-between text-xs text-neutral-500">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className="flex h-5 w-5 items-center justify-center rounded border border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            −
          </button>
          <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className="flex h-5 w-5 items-center justify-center rounded border border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            +
          </button>
          {zoom !== 1 && (
            <button type="button" onClick={() => setZoom(1)} className="text-neutral-500 hover:underline">
              Reset zoom
            </button>
          )}
        </div>
        <span>Shortcuts: click diagram, then +/− to zoom, 0 to reset, or Ctrl/Cmd+scroll</span>
      </div>
      <div className="flex min-h-[1.5rem] items-center gap-3 text-xs">
        {!valid && <span className="text-red-600">Overlapping or out-of-bounds parts (shown in red) can&apos;t be saved.</span>}
        {error && <span className="text-red-600">{error}</span>}
        {dirty && (
          <>
            <button type="button" onClick={handleReset} className="text-neutral-500 hover:underline">
              Reset
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!valid || isPending}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1 font-medium text-neutral-900 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Save layout"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
