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

// A long sourceQuote shown in full to the chat model would eat into the
// same character budget every document competes for (chat-context-
// service.ts), for a fact ("which document/page a line item came from")
// that rarely needs the whole quote to make the point. `matchable` is
// the truncated text WITHOUT the ellipsis -- used both as what's shown to
// the model (with `display`'s ellipsis appended) and as the candidate
// text linkifyMentions later searches for in the model's reply, so a
// model that echoes the quote back verbatim (confirmed common in
// practice, same as it does for filenames) still gets a real citation
// link rather than one that silently never matches because the search
// text and the shown text quietly diverged.
export function truncateForCitation(text: string, maxLength: number): { display: string; matchable: string } {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return { display: trimmed, matchable: trimmed };
  const cut = trimmed.slice(0, maxLength).trim();
  return { display: `${cut}…`, matchable: cut };
}

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

// A line item eligible to be linkified in a chat reply -- see
// chat-service.ts's getCitableLineItems, the only real producer of this
// shape (estimateId comes from the Estimate the item's section rolls up
// to, not a column on LineItem itself).
export interface CitableLineItem {
  id: string;
  estimateId: string;
  description: string;
}

// Below this, a description is too generic to safely auto-link -- "Labor"
// or "Freight" appearing in ordinary prose about the job would get
// wrongly linked to one arbitrary line item far more often than a real
// reference to it. Filenames never needed this guard: they're already
// long and distinctive on their own.
const MIN_LINE_ITEM_MATCH_LENGTH = 12;

// A source-document excerpt eligible to be linkified -- see
// chat-service.ts's getCitableQuotes. `match` is a line item's
// (possibly-truncated, see truncateForCitation) sourceQuote; `href` is
// already a real citationHref -- a precise page-and-quote-highlight link
// into the actual document, not just its viewer's homepage the way a
// bare filename mention resolves. This is the "real" half of Phase 2's
// structured citation: sourceQuote/sourcePageNumber were already stored
// on LineItem by the pricing-schedule import or AI-verified extraction
// (see LineItem's own schema comment) -- this just finally surfaces that
// existing, already-verified link inside a chat reply instead of leaving
// it to only ever be reachable from the Estimate page's line item table.
export interface CitableQuote {
  match: string;
  href: string;
}

// Chat's system prompt (chat-context-service.ts) already tells the model
// to name the source document and the estimate/section a line item is in
// -- confirmed in practice, it reliably does. Rather than asking for a
// second, separately-fallible structured citation (a new schema, a new
// place for the model to hallucinate a document or item that doesn't
// exist), this just finds real filenames, line-item descriptions, and
// line-item source quotes the reply already mentions and turns them into
// markdown links -- straight to that document's viewer (or, for a real
// sourceQuote, the exact page with that quote highlighted), or to that
// exact line item row via its `#line-item-<id>` anchor (line-item-
// row.tsx), the same anchor citationHref above already relies on
// elsewhere. Returns the ORIGINAL markdown text with `[matched](href)`
// spliced in, not a rendered string, so ChatWidget's single react-
// markdown pass still handles bold/lists/etc. around the link normally.
// Longest match first (across all three candidate kinds together) so a
// short one that happens to be a substring of a longer one doesn't steal
// it -- in practice a real sourceQuote is almost always the longest,
// most specific candidate in play, so it naturally wins over a shorter
// description or filename spanning the same text.
//
// Description-based line-item links and filename links are still a
// best-effort text match, not a real citation -- they can miss a
// paraphrased mention, and (bounded by MIN_LINE_ITEM_MATCH_LENGTH) won't
// touch a short generic description at all. Quote-based links don't have
// that problem the same way: sourceQuote is real, already-verified data,
// not a guess -- the only failure mode there is the model paraphrasing
// instead of quoting it back verbatim.
export function linkifyMentions(
  text: string,
  opportunityId: string,
  documents: { id: string; filename: string }[],
  lineItems: CitableLineItem[] = [],
  quotes: CitableQuote[] = [],
): string {
  const candidates = [
    ...documents
      .filter((d) => d.filename.length > 0)
      .map((d) => ({ match: d.filename, href: `/opportunities/${opportunityId}/documents/${d.id}/view` })),
    ...lineItems
      .filter((li) => li.description.trim().length >= MIN_LINE_ITEM_MATCH_LENGTH)
      .map((li) => ({ match: li.description, href: `/estimates/${li.estimateId}#line-item-${li.id}` })),
    ...quotes.filter((q) => q.match.trim().length > 0),
  ];
  if (candidates.length === 0) return text;
  const byLengthDesc = [...candidates].sort((a, b) => b.match.length - a.match.length);

  let result = "";
  let remaining = text;

  while (remaining.length > 0) {
    let matchIndex = -1;
    let matched: (typeof byLengthDesc)[number] | null = null;

    for (const c of byLengthDesc) {
      const idx = remaining.toLowerCase().indexOf(c.match.toLowerCase());
      if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
        matchIndex = idx;
        matched = c;
      }
    }

    if (matchIndex === -1 || !matched) {
      result += remaining;
      break;
    }

    if (matchIndex > 0) result += remaining.slice(0, matchIndex);
    const matchedText = remaining.slice(matchIndex, matchIndex + matched.match.length);
    result += `[${matchedText}](${matched.href})`;
    remaining = remaining.slice(matchIndex + matched.match.length);
  }

  return result;
}
