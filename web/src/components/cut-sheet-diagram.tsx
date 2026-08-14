import { BRAND } from "@/lib/brand";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";
import { toggleCutSheetLockAction, toggleCutSheetCutAction } from "@/app/(app)/estimates/[id]/versions/[versionId]/cut-list/actions";

// Cut-list phase 6: a real DOM <svg> port of cut-sheet-pdf.tsx's per-sheet
// layout math (scale/labelFontSize/canLabel threshold, kept identical),
// so a user sees the packed layout inline the moment they click
// Optimize instead of only via a PDF opened in a new tab. @react-pdf/
// renderer's <Svg>/<Rect>/<Text> are PDF-specific primitives, not real
// DOM elements -- can't be reused directly here. No client interactivity
// needed for a static read display, so this stays a plain server
// component like the rest of this page.
const DIAGRAM_MAX_WIDTH = 500;
const DIAGRAM_MAX_HEIGHT = 380;

export function CutSheetDiagram({
  estimateId,
  versionId,
  materialId,
  sheet,
  sheetCount,
  versionLocked = false,
}: {
  estimateId: string;
  versionId: string;
  materialId: string;
  sheet: CutSheetDiagramData["sheets"][number];
  sheetCount: number;
  // The lock/unlock toggle is a cut-list EDIT (gated by assertUnlocked
  // same as everything else), so it's hidden once the whole
  // EstimateVersion is locked -- it would only ever fail, same
  // hide-rather-than-error convention cut-list/page.tsx already uses for
  // its Add-a-part form/delete buttons/Optimize buttons.
  versionLocked?: boolean;
}) {
  // Each sheet draws against ITS OWN real usable area -- a remnant's own
  // (smaller) dimensions, not the material's nominal stock size, or the
  // diagram would show the wrong sheet size. See cut-sheet-pdf.tsx.
  const scale = Math.min(DIAGRAM_MAX_WIDTH / sheet.width, DIAGRAM_MAX_HEIGHT / sheet.length);
  const svgWidth = sheet.width * scale;
  const svgHeight = sheet.length * scale;
  const labelFontSize = Math.max(Math.min(sheet.width, sheet.length) * 0.018, 0.15);

  // Phase 8: plain <form action> toggles -- no client-side interactivity
  // needed for a simple flip, matching every other server-action button
  // in this app. Works fine in this still-plain server component.
  const toggleLockWithIds = toggleCutSheetLockAction.bind(null, estimateId, versionId, materialId, sheet.sheetNumber);
  const toggleCutWithIds = toggleCutSheetCutAction.bind(null, estimateId, versionId, materialId, sheet.sheetNumber);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex w-full items-center justify-between text-xs text-neutral-500">
        <span>
          Sheet {sheet.sheetNumber} of {sheetCount}
          {sheet.isRemnant && <span className="ml-2 font-semibold uppercase tracking-wide text-brand-tangerine">Remnant</span>}
          {sheet.locked && <span className="ml-2 font-semibold uppercase tracking-wide text-neutral-600">Locked</span>}
        </span>
        <span className="flex items-center gap-3">
          Stock: {sheet.width}&quot; x {sheet.length}&quot;
          {!versionLocked && (
            <form action={toggleLockWithIds}>
              <button type="submit" className="rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-50">
                {sheet.locked ? "Unlock" : "Lock"}
              </button>
            </form>
          )}
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
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${sheet.width} ${sheet.length}`}
        className="rounded-sm border border-neutral-300 bg-white"
      >
        <rect x={0} y={0} width={sheet.width} height={sheet.length} fill="#ffffff" stroke={BRAND.black} strokeWidth={0.05} />
        {sheet.parts.map((part, i) => {
          const canLabel = part.width > labelFontSize * 5 && part.height > labelFontSize * 2.5;
          return (
            <g key={part.cutListPartId + i}>
              <rect
                x={part.x}
                y={part.y}
                width={part.width}
                height={part.height}
                fill={BRAND.tealPale}
                stroke={BRAND.teal}
                strokeWidth={0.03}
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
      </svg>
    </div>
  );
}
