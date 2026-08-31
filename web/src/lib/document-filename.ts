// A CAD drawing and its vendor's own per-booth pricing workbook share the
// same filename stem in every real job seen so far (e.g. "SUPER BOWL A
// 6.8.2 SECTION 428.pdf" / "SUPER BOWL A 6.8.2 SECTION 428.xlsx") --
// confirmed live against a real production job where this exact pairing
// existed for all 13 booths. Shared by estimate-synthesis-service.ts (to
// recognize "this drawing's scope is already covered by its matching
// workbook, skip AI-vision extraction") and cad-enrichment-service.ts (to
// scope which already-committed line items a CAD Pull Sheet is allowed to
// enrich).
export function filenameStem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").trim().toLowerCase();
}
