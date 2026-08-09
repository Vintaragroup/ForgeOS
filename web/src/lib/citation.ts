// Shared by the Project Brief (opportunities/[id]/page.tsx) and the
// Dashboard's upcoming-deadlines list (dashboard.ts) -- both link an
// AI-extracted fact back to where it came from, using the two mechanisms
// document-view-service.ts's viewer understands: a PDF page jump +
// in-viewer highlight (?page=N&q=<quote>, using Chromium's built-in PDF
// viewer's #page=N&search=<text> open-parameters -- the same viewer
// PDFium/Adobe Reader use to highlight every match in yellow and jump to
// the first one, no PDF.js or custom text layer needed) or a DOCX
// text-search highlight (?q=<quote>#hl).
import { DOCX_MIME, PDF_MIME } from "@/lib/ai/text-extraction";

export function citationHref(
  opportunityId: string,
  doc: { id: string; mimeType: string },
  fact: { sourceQuote: string; pageNumber: number | null },
): string | null {
  const base = `/opportunities/${opportunityId}/documents/${doc.id}/view`;
  if (doc.mimeType === PDF_MIME && fact.pageNumber) {
    const q = fact.sourceQuote ? `&q=${encodeURIComponent(fact.sourceQuote)}` : "";
    return `${base}?page=${fact.pageNumber}${q}`;
  }
  if (doc.mimeType === DOCX_MIME && fact.sourceQuote) {
    return `${base}?q=${encodeURIComponent(fact.sourceQuote)}#hl`;
  }
  return null;
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
