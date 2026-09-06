// Shared currency formatter -- used by both a Prisma Decimal value
// (estimate/version totals) and a plain number (a value already summed in
// JS, e.g. opportunities/[id]/page.tsx's header estimate total). Both
// satisfy this one duck-typed interface (Decimal.toFixed and
// Number.prototype.toFixed have the same signature), so one function
// covers both without a union type or a runtime branch -- previously
// duplicated near-identically across estimates/[id]/page.tsx and
// opportunities/[id]/page.tsx.
export function money(d: { toFixed(n: number): string }): string {
  return `$${Number(d.toFixed(2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
