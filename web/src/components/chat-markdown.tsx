"use client";

import Link from "next/link";
import type { Components } from "react-markdown";

// Deliberately plain: no headings, no tables, no raw HTML passthrough
// (react-markdown never executes raw HTML in the source unless told to --
// left that way on purpose, since document text quoted back by the model
// is untrusted input). A short paragraph, an occasional list, bold for
// emphasis, and a link is the entire vocabulary a chat reply here
// actually needs -- see chat-context-service.ts's SYSTEM_PREAMBLE, which
// asks for exactly that register.
const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) =>
    href ? (
      <Link href={href} className="underline decoration-dotted underline-offset-2 hover:decoration-solid">
        {children}
      </Link>
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
    <pre className="mb-2 overflow-x-auto rounded-md bg-neutral-900 p-2.5 text-xs text-neutral-100 last:mb-0">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-neutral-300 pl-3 text-neutral-600 last:mb-0">{children}</blockquote>
  ),
  // Downgraded to a bold line rather than an actual heading -- a real
  // <h1>/<h2> reads as a document section inside a ~24rem chat bubble,
  // not a reply (see the SYSTEM_PREAMBLE comment this mirrors).
  h1: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
  h2: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
  h3: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
};

export const chatMarkdownComponents = markdownComponents;
