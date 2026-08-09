"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { sendWidgetMessageAction } from "@/app/(app)/opportunities/[id]/chat/actions";
import type { TextSegment } from "@/lib/citation";

interface ChatMessageData {
  id: string;
  role: string;
  segments: TextSegment[];
}

// A filename the model mentioned, turned into a link by
// linkifyDocumentMentions (citation.ts) server-side before this ever
// reaches the client -- rendered plain vs. linked per segment rather than
// dumping raw HTML, so this stays as safe as any other React text content.
function MessageContent({ segments }: { segments: TextSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.href ? (
          <Link key={i} href={seg.href} className="underline decoration-dotted underline-offset-2 hover:decoration-solid">
            {seg.text}
          </Link>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

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
  }, [messages, open]);

  function submitMessage() {
    const content = input.trim();
    if (!content || isPending) return;
    setError(null);
    setMessages((prev) => [...prev, { id: `pending-${Date.now()}`, role: "user", segments: [{ text: content, href: null }] }]);
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
      className={`fixed right-5 bottom-5 z-50 flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl transition-[width,height] ${
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

      <div ref={listRef} className="flex-1 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <p className="p-4 text-center text-sm text-neutral-400">
            Ask about this opportunity&apos;s documents or its current estimate.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((m) => (
              <li
                key={m.id}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === "user" ? "ml-auto bg-brand-black text-white" : "bg-neutral-100 text-neutral-900"
                }`}
              >
                <MessageContent segments={m.segments} />
              </li>
            ))}
          </ul>
        )}
        {isPending && <p className="mt-2 px-1 text-xs text-neutral-400">Thinking…</p>}
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
