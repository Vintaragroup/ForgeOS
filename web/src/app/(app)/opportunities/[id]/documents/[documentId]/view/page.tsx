import { notFound, redirect } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { getDocument, getDocumentBytes } from "@/lib/document-service";
import {
  renderDocx,
  renderSpreadsheet,
  highlightQuote,
  findSpreadsheetMatch,
  renderHighlightedPdfPage,
} from "@/lib/document-view-service";
import { DOCX_MIME, PDF_MIME, XLSX_MIME, isTextOrMarkdownDocument } from "@/lib/ai/text-extraction";
import { getCitableLineItems, getCitableQuotes, getThreadMessages } from "@/lib/chat-service";
import { linkifyMentions } from "@/lib/citation";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { ChatWidget } from "@/components/chat-widget";

export const dynamic = "force-dynamic";

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg"];

export default async function DocumentViewPage(
  props: PageProps<"/opportunities/[id]/documents/[documentId]/view">,
) {
  const { id, documentId } = await props.params;
  const { page, q, returnTo } = await props.searchParams;
  const pageParam = Array.isArray(page) ? page[0] : page;
  const quoteParam = Array.isArray(q) ? q[0] : q;
  const returnToParam = Array.isArray(returnTo) ? returnTo[0] : returnTo;
  // Every citation link (citation.ts's citationHref) carries returnTo --
  // the exact page + section the user clicked from -- so "back" lands
  // there instead of the generic Documents list. Guarded to a real
  // same-origin relative path (starts with "/", not "//") since this is
  // an attacker-editable query param; anything else falls back to
  // today's unchanged default.
  const hasValidReturnTo = !!returnToParam && returnToParam.startsWith("/") && !returnToParam.startsWith("//");
  const backTarget = hasValidReturnTo ? returnToParam! : `/opportunities/${id}`;
  const backLabelText = hasValidReturnTo ? "Back" : "Documents";

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let document;
  try {
    document = await getDocument(documentId);
  } catch {
    notFound();
  }
  if (document.opportunityId !== id) notFound();
  if (!(await canAccessOpportunity(user, id))) notFound();

  const [opportunity, chatMessages, allDocuments, citableLineItems, citableQuotes] = await Promise.all([
    db.opportunity.findFirst({ where: { id }, select: { showName: true } }),
    getThreadMessages(id),
    db.document.findMany({ where: { opportunityId: id, deletedAt: null }, select: { id: true, filename: true } }),
    getCitableLineItems(id),
    getCitableQuotes(id),
  ]);

  const rawUrl = `/opportunities/${id}/documents/${documentId}`;
  // A Project Brief citation links here with ?page=N&q=<quote> for a PDF --
  // #page=N is genuine, well-supported native browser PDF viewer behavior,
  // used for the full iframe below. Actually highlighting the quote
  // inside that embedded viewer isn't possible -- an earlier #search=
  // open-parameter attempt was confirmed not working, and the viewer
  // itself isn't inspectable to try further. HighlightedPdfPage below
  // solves this a different way: it renders just the cited page as its
  // own image with the match actually marked on it (document-view-
  // service.ts's renderHighlightedPdfPage), shown above the iframe rather
  // than trying to control the iframe's own viewer.
  const inlineUrl = `${rawUrl}?inline=1${pageParam ? `#page=${pageParam}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref={backTarget}
        backLabel={backLabelText}
        title={document.filename}
        action={<LinkButton href={rawUrl} variant="secondary">Download</LinkButton>}
      />

      {quoteParam && <ReferencedExcerpt quote={quoteParam} />}

      {document.mimeType === PDF_MIME && pageParam && quoteParam && (
        <HighlightedPdfPage documentId={documentId} page={Number(pageParam)} quote={quoteParam} filename={document.filename} />
      )}

      {document.mimeType === PDF_MIME ? (
        <Card className="overflow-hidden">
          <iframe src={inlineUrl} title={document.filename} className="h-[85vh] w-full" />
        </Card>
      ) : IMAGE_MIMES.includes(document.mimeType) ? (
        <Card className="flex justify-center p-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded content from private storage, not an optimizable static asset */}
          <img src={`${rawUrl}?inline=1`} alt={document.filename} className="max-w-full" />
        </Card>
      ) : document.mimeType === XLSX_MIME ? (
        <SpreadsheetView documentId={documentId} quote={quoteParam} />
      ) : document.mimeType === DOCX_MIME ? (
        <DocxView documentId={documentId} quote={quoteParam} />
      ) : isTextOrMarkdownDocument(document.mimeType, document.filename) ? (
        <MarkdownView documentId={documentId} />
      ) : (
        <Card className="p-10 text-center text-sm text-neutral-500">
          This file type can&apos;t be previewed in-app. Download it to view it locally.
        </Card>
      )}

      {opportunity && (
        <ChatWidget
          opportunityId={id}
          opportunityName={opportunity.showName}
          initialMessages={chatMessages.map((m) => ({
            id: m.id,
            role: m.role,
            content: linkifyMentions(m.content, id, allDocuments, citableLineItems, citableQuotes),
          }))}
        />
      )}
    </div>
  );
}

// The one piece of this citation flow that doesn't depend on any
// particular viewer's behavior: whatever quote the citation carries is
// shown here, marked exactly like a yellow highlighter, regardless of
// whether the PDF/DOCX viewer below it manages to scroll/highlight
// in-place on its own. Plain server-rendered HTML -- always renders the
// same way, unlike relying on an embedded PDF viewer's undocumented
// support for a search parameter.
function ReferencedExcerpt({ quote }: { quote: string }) {
  return (
    <Card className="border-l-4 border-amber-400 bg-amber-50 p-4">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700">Referenced text</p>
      <p className="text-sm text-neutral-800">
        <mark style={{ background: "#fddfb1" }}>{quote}</mark>
      </p>
    </Card>
  );
}

// Renders below ReferencedExcerpt as a companion, not a replacement --
// this is the actual fix for "I have to search for it myself" (see
// renderHighlightedPdfPage's own header comment for why the embedded PDF
// viewer itself can't be made to highlight). Renders nothing when no
// confident match is found -- ReferencedExcerpt and the full iframe below
// are unaffected either way, so a failed match degrades gracefully rather
// than showing a broken or empty box.
async function HighlightedPdfPage({
  documentId,
  page,
  quote,
  filename,
}: {
  documentId: string;
  page: number;
  quote: string;
  filename: string;
}) {
  const { bytes } = await getDocumentBytes(documentId);
  const dataUrl = await renderHighlightedPdfPage(bytes, page, quote);
  if (!dataUrl) return null;
  return (
    <Card className="overflow-hidden p-6">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-700">
        Highlighted in document (page {page})
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL, not a static/optimizable asset */}
      <img src={dataUrl} alt={`${filename}, page ${page}, with citation highlighted`} className="max-w-full" />
    </Card>
  );
}

async function SpreadsheetView({ documentId, quote }: { documentId: string; quote?: string }) {
  const { bytes } = await getDocumentBytes(documentId);
  const sheets = await renderSpreadsheet(bytes);
  // An estimate line item's "Source" link carries the exact cell text it
  // was imported from (pricing-import-service.ts) -- an equality match
  // against the same rendered rows, not a fuzzy search. The browser
  // natively scrolls to id="hl" on load via the URL's own #hl fragment,
  // same mechanism DocxView uses, no client JS needed.
  const match = quote ? findSpreadsheetMatch(sheets, quote) : null;

  return (
    <div className="flex flex-col gap-6">
      {sheets.map((sheet, sheetIndex) => (
        <Card key={sheet.name} className="p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {sheet.name}
          </h2>
          {sheet.rows.length === 0 ? (
            <p className="text-sm text-neutral-400">Empty sheet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-neutral-200">
              <table className="w-full text-xs">
                <tbody>
                  {sheet.rows.map((row, i) => {
                    const isMatchRow = match && match.sheetIndex === sheetIndex && match.rowIndex === i;
                    return (
                      <tr
                        key={i}
                        id={isMatchRow ? "hl" : undefined}
                        className={`border-t border-neutral-100 first:border-t-0 ${isMatchRow ? "bg-amber-100" : ""}`}
                      >
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            className={`whitespace-nowrap px-2 py-1 ${isMatchRow && match.cellIndex === j ? "font-semibold text-amber-900" : ""}`}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

async function DocxView({ documentId, quote }: { documentId: string; quote?: string }) {
  const { bytes } = await getDocumentBytes(documentId);
  const html = await renderDocx(bytes);
  const highlighted = quote ? highlightQuote(html, quote) : html;

  // The browser natively scrolls to <mark id="hl"> on load when the URL's
  // own fragment is #hl (see the Project Brief's citation links) -- no
  // client JS needed here, just making sure the id exists when it should.
  return (
    <Card className="p-8">
      <div className="docx-view text-sm" dangerouslySetInnerHTML={{ __html: highlighted }} />
    </Card>
  );
}

// Full document headings/tables, unlike chat-widget.tsx's own
// markdownComponents -- that set deliberately downgrades headings to a
// bold line because a real <h1> inside a ~24rem chat bubble reads as a
// document section, not a reply. A standalone document view has no such
// constraint; a design note or README-style scope doc legitimately wants
// real section headings. No in-context quote highlighting here (unlike
// DocxView/SpreadsheetView) -- ReferencedExcerpt above already shows the
// cited text; scoped out as a smaller, deliberate gap rather than full
// parity with every other viewer's highlighting.
const documentMarkdownComponents: Components = {
  h1: ({ children }) => <h1 className="mb-3 text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mb-3 leading-relaxed last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} className="underline decoration-dotted underline-offset-2 hover:decoration-solid">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  code: ({ className, children }) =>
    /language-/.test(className ?? "") ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-neutral-900/[0.06] px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-100 last:mb-0">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-neutral-300 pl-3 text-neutral-600 last:mb-0">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto rounded-md border border-neutral-200">
      <table className="w-full text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-neutral-200 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-t border-neutral-100 px-2 py-1">{children}</td>,
  hr: () => <hr className="my-4 border-neutral-200" />,
};

async function MarkdownView({ documentId }: { documentId: string }) {
  const { bytes } = await getDocumentBytes(documentId);
  const text = bytes.toString("utf-8");

  return (
    <Card className="p-8">
      <div className="text-sm">
        {/* remark-gfm: react-markdown's default is CommonMark only -- a
            table (a real scope/spec doc's own GFM table syntax, confirmed
            live: without this it rendered as one raw "| Item | Qty | ..."
            line instead of an actual table) needs GFM explicitly. */}
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={documentMarkdownComponents}>
          {text}
        </ReactMarkdown>
      </div>
    </Card>
  );
}
