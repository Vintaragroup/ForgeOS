"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import { sendWidgetMessageAction } from "@/app/(app)/opportunities/[id]/chat/actions";

interface ChatMessageData {
  id: string;
  role: string;
  // Markdown, with any document/line-item mention linkifyMentions
  // (citation.ts) recognized already rewritten to real markdown links
  // server-side -- rendered through the same single react-markdown pass
  // as everything else, rather than a separate plain-text/link split, so
  // a link inside a bullet list or bolded phrase renders correctly
  // instead of breaking the surrounding formatting.
  content: string;
  // Set only on a just-sent reply, when buildChatContext had to leave
  // documents or line items out of the prompt for length -- not persisted,
  // so it never appears on messages loaded from history.
  notice?: string | null;
}

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

// The third client component in this app (after app-nav.tsx and
// confirm-form.tsx) -- a floating widget needs real open/minimized/
// maximized state and an append-as-you-go message list, which a plain
// Server Action form (the old full-page /chat route) can't do without a
// page reload per message. Server Actions still do the actual work here
// (sendWidgetMessageAction), just invoked directly instead of via
// <form action>, since this is client code calling into one.
export function ChatWidget({
  opportunityId,
  opportunityName,
  initialMessages,
}: {
  opportunityId: string;
  opportunityName: string;
  initialMessages: ChatMessageData[];
}) {
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [messages, setMessages] = useState<ChatMessageData[]>(initialMessages);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open, isPending]);

  function submitMessage() {
    const content = input.trim();
    if (!content || isPending) return;
    setError(null);
    setMessages((prev) => [...prev, { id: `pending-${Date.now()}`, role: "user", content }]);
    setInput("");
    startTransition(async () => {
      try {
        const assistantMessage = await sendWidgetMessageAction(opportunityId, content);
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong sending that message.");
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open chat"
        className="fixed right-5 bottom-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-brand-black text-white shadow-lg transition-transform hover:scale-105"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4.6 3.45A.5.5 0 0 1 3.6 20V6a1 1 0 0 1 1-1Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }

  return (
    <div
      className={`fixed right-5 bottom-5 z-50 flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl transition-[width,height] ${
        maximized ? "h-[85vh] w-[30rem] max-w-[calc(100vw-2.5rem)]" : "h-[32rem] w-96 max-w-[calc(100vw-2.5rem)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2 bg-brand-black px-4 py-3 text-white">
        <span className="truncate text-sm font-medium">{opportunityName}</span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setMaximized((v) => !v)}
            aria-label={maximized ? "Restore chat" : "Maximize chat"}
            className="rounded p-1.5 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            {maximized ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 15v5m0-5H4m11-6V4m0 5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Minimize chat"
            className="rounded p-1.5 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-3.5 py-4">
        {messages.length === 0 ? (
          <p className="p-4 text-center text-sm text-neutral-400">
            Ask about this opportunity&apos;s documents or its current estimate.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {messages.map((m) => (
              <li key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={m.role === "user" ? "max-w-[85%]" : "max-w-full"}>
                  <div
                    className={
                      m.role === "user"
                        ? "rounded-2xl rounded-br-md bg-brand-black px-3.5 py-2 text-sm text-white [&_a]:decoration-white/60"
                        : "text-sm text-neutral-800"
                    }
                  >
                    <ReactMarkdown components={markdownComponents}>{m.content}</ReactMarkdown>
                  </div>
                  {m.notice && <p className="mt-1.5 text-xs text-amber-600">{m.notice}</p>}
                </div>
              </li>
            ))}
            {isPending && (
              <li className="flex justify-start">
                <div className="flex items-center gap-1 py-1" aria-label="Assistant is typing">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-300 motion-reduce:animate-none [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-300 motion-reduce:animate-none [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-300 motion-reduce:animate-none" />
                </div>
              </li>
            )}
          </ul>
        )}
      </div>

      {error && (
        <p className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitMessage();
        }}
        className="flex items-end gap-2 border-t border-neutral-200 p-3"
      >
        <label htmlFor="chat-widget-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-widget-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitMessage();
            }
          }}
          rows={1}
          placeholder="Ask a question…"
          className="flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          disabled={isPending || !input.trim()}
          className="rounded-md bg-brand-black px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-navy disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
