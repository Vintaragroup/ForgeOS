// Shared, dependency-free constant -- used by both server code
// (estimate-service.ts's validation) and a client component
// (summary-editor.tsx's textarea maxLength), so it can't import anything
// server-only (db, Prisma) the way estimate-service.ts does.
//
// Booth/element/category proposal summaries (EstimateSection.boothSummary/
// elementSummary, EstimateCategorySummary.summary) are meant to be "a few
// client-readable sentences" (see their own schema comments), but nothing
// ever enforced that -- confirmed live via /code-review ultra: proposal-
// pdf.tsx wraps each summary with its header in a `wrap={false}` block (so
// a header never gets orphaned from its own summary across a page break),
// but react-pdf's wrap={false} doesn't clip or paginate an oversized block
// that's taller than a full page -- it renders unsplit and overflows off
// the page bottom, silently pushing every following booth/line item one
// page later, confirmed against react-pdf's own layout source
// (@react-pdf/layout's splitNodes). Measured against this app's actual
// PDF text styles (fontSize 8.5, lineHeight 1.6, ~648pt content area),
// roughly 4,500+ characters is enough to trigger it. 800 is comfortably
// within "a few sentences" (roughly 120-150 words) with a large safety
// margin below that failure threshold.
export const MAX_PROPOSAL_SUMMARY_LENGTH = 800;

// Shared by every client-facing renderer of a booth/element/category
// summary (proposal-pdf.tsx and the web proposal page) -- the authoritative
// safety net for the wrap={false} overflow bug documented above: estimate-
// service.ts rejects a new summary over the cap at write time, but that
// can't retroactively fix one already stored before this cap existed.
// Truncating here guarantees no renderer can ever show an oversized
// header+summary block regardless of what's actually in the database.
export function truncateProposalSummary(text: string): string {
  if (text.length <= MAX_PROPOSAL_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_PROPOSAL_SUMMARY_LENGTH).trimEnd()}…`;
}
