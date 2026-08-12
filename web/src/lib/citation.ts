// Shared by the Project Brief (opportunities/[id]/page.tsx), the Estimate
// line item list (estimates/[id]/page.tsx), and the Dashboard's
// upcoming-deadlines list (dashboard.ts) -- all link an extracted/parsed
// fact back to where it came from, using the mechanisms
// document-view-service.ts's viewer understands: a PDF page jump + the
// "Referenced text" highlight callout (?page=N&q=<quote> --
// view/page.tsx renders the quote as a real, always-visible highlighted
// excerpt rather than depending on any particular PDF plugin's own
// search behavior), a DOCX text-search highlight (?q=<quote>#hl), or an
// XLSX cell highlight (?q=<quote>#hl, same fragment convention as DOCX).
import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@/lib/ai/text-extraction";

// `returnTo` is an optional relative URL (path + hash, e.g.
// `/estimates/abc123#line-item-xyz`) the document viewer's Back link
// should return to instead of its generic Opportunity-documents fallback
// -- see view/page.tsx. Every call site passes its own current page plus
// a hash anchor at the specific row/section the citation came from, so
// "back" lands exactly where the user was, not just on the right page.
export function citationHref(
  opportunityId: string,
  doc: { id: string; mimeType: string },
  fact: { sourceQuote: string; pageNumber: number | null },
  returnTo?: string,
): string | null {
  const base = `/opportunities/${opportunityId}/documents/${doc.id}/view`;
  // Built manually with encodeURIComponent, not URLSearchParams -- its
  // .toString() encodes spaces as "+", not "%20", which would silently
  // change every existing citation link's exact encoding.
  const params: string[] = [];
  let hash = "";

  if (doc.mimeType === PDF_MIME && fact.pageNumber) {
    params.push(`page=${fact.pageNumber}`);
    if (fact.sourceQuote) params.push(`q=${encodeURIComponent(fact.sourceQuote)}`);
  } else if ((doc.mimeType === DOCX_MIME || doc.mimeType === XLSX_MIME) && fact.sourceQuote) {
    params.push(`q=${encodeURIComponent(fact.sourceQuote)}`);
    hash = "#hl";
  } else if (doc.mimeType.startsWith("image/") && fact.pageNumber) {
    // A raw-image drawing upload (see drawing-summary-service.ts) has no
    // page/quote concept -- just jump to the document itself.
  } else {
    return null;
  }

  if (returnTo) params.push(`returnTo=${encodeURIComponent(returnTo)}`);
  return `${base}${params.length > 0 ? `?${params.join("&")}` : ""}${hash}`;
}

// Free-text dates ("August 31, 2026") mostly parse via the Date
// constructor as-is. A range is checked FIRST, not as a fallback after the
// direct parse fails -- it doesn't fail. `new Date("August 17-20, 2026")`
// AND `new Date("17-20 August 2026")` both silently return a
// plausible-looking but WRONG date (year 2020, not 2026 -- confirmed
// against Node's own V8; caught by citation.test.ts), so isNaN can't be
// trusted to catch this case at all. Two range shapes seen in real RFP
// documents so far -- "Month Day-Day, Year" (RFP body) and
// "Day-Day Month Year" (Appendix event schedules) -- both collapse to
// their start date. Best-effort surfacing for the Dashboard, not
// authoritative record-keeping -- the citation link is what takes someone
// to the actual source if a parse is still off.
export function parseFreeTextDate(raw: string): Date | null {
  const monthFirst = raw.match(/^([A-Za-z]+\s+\d{1,2})\s*-\s*\d{1,2}\s*,\s*(\d{4})$/);
  if (monthFirst) {
    const collapsed = new Date(`${monthFirst[1]}, ${monthFirst[2]}`);
    if (!isNaN(collapsed.getTime())) return collapsed;
  }

  const dayFirst = raw.match(/^(\d{1,2})\s*-\s*\d{1,2}\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dayFirst) {
    const collapsed = new Date(`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`);
    if (!isNaN(collapsed.getTime())) return collapsed;
  }

  const direct = new Date(raw);
  if (!isNaN(direct.getTime())) return direct;

  // "14th February 2027" / "February 14th, 2027" -- JS's Date constructor
  // doesn't understand ordinal day suffixes at all (Invalid Date, not a
  // partial parse), and models routinely write dates this way when asked
  // to keep a date "as written" from RFP prose that itself uses ordinals.
  // Stripping the suffix and retrying the same direct parse covers it
  // without a bespoke regex per date shape.
  const deOrdinalized = raw.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  if (deOrdinalized !== raw) {
    const retried = new Date(deOrdinalized);
    if (!isNaN(retried.getTime())) return retried;
  }

  return null;
}

export interface TextSegment {
  text: string;
  href: string | null;
}

// Chat's system prompt (chat-context-service.ts) already tells the model
// to name the source document when it states a fact -- confirmed in
// practice, it reliably does. Rather than asking for a second,
// separately-fallible structured citation (a new schema, a new place for
// the model to hallucinate a document that doesn't exist), this just
// finds real filenames the reply already mentions and turns them into
// links to that document's viewer. Longest filename matches first so a
// short one that happens to be a substring of a longer one doesn't steal
// the match.
export function linkifyDocumentMentions(
  text: string,
  opportunityId: string,
  documents: { id: string; filename: string }[],
): TextSegment[] {
  if (documents.length === 0) return [{ text, href: null }];
  const byLengthDesc = [...documents].sort((a, b) => b.filename.length - a.filename.length);

  const segments: TextSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let matchIndex = -1;
    let matchDoc: (typeof byLengthDesc)[number] | null = null;

    for (const doc of byLengthDesc) {
      const idx = remaining.toLowerCase().indexOf(doc.filename.toLowerCase());
      if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
        matchIndex = idx;
        matchDoc = doc;
      }
    }

    if (matchIndex === -1 || !matchDoc) {
      segments.push({ text: remaining, href: null });
      break;
    }

    if (matchIndex > 0) segments.push({ text: remaining.slice(0, matchIndex), href: null });
    const matched = remaining.slice(matchIndex, matchIndex + matchDoc.filename.length);
    segments.push({ text: matched, href: `/opportunities/${opportunityId}/documents/${matchDoc.id}/view` });
    remaining = remaining.slice(matchIndex + matchDoc.filename.length);
  }

  return segments;
}
