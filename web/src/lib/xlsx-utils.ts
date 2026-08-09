// Shared exceljs cell-text extraction, used by both the pricing-schedule
// importer (pricing-import-service.ts) and the generic spreadsheet
// viewer (document-view-service.ts) -- one place for the richText/date/
// number normalization rather than two copies drifting apart.

export function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && "richText" in (value as object)) {
    return (value as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
  }
  if (typeof value === "object" && "result" in (value as object)) {
    // A formula cell -- exceljs exposes both `formula` and its computed `result`.
    return cellText((value as { result: unknown }).result);
  }
  return String(value).trim();
}
