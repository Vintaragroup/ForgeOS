"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import { chatMarkdownComponents } from "@/components/chat-markdown";
import {
  listAssistantThreadsAction,
  loadAssistantThreadAction,
  sendAssistantMessageAction,
  startAssistantThreadAction,
  type AssistantMessageData,
  type AssistantThreadSummary,
} from "@/app/(app)/sales/assistant-actions";

// A department's assistant, as a floating widget on that department's
// landing page. Same shape as the opportunity ChatWidget (open/minimize,
// append-as-you-go), plus what that one doesn't have: several saved
// conversations, the way a desktop assistant does -- start a new one,
// come back to an old one.
//
// Answer-only by design (v1): there is no action button here because the
// service behind it has no tools. It explains and links; changes happen
// on real pages with their own checks.

function relativeDay(iso: string | null): string {
  if (!iso) return "new";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function AssistantWidget({
  departmentCode,
  label,
  description,
  suggestions,
  initialThreads,
}: {
  departmentCode: string;
  label: string;
  description: string;
  suggestions: string[];
  initialThreads: AssistantThreadSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [threads, setThreads] = useState(initialThreads);
  const [threadId, setThreadId] = useState<string | null>(initialThreads[0]?.id ?? null);
  const [messages, setMessages] = useState<AssistantMessageData[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);
  const loadedThreadRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open, isPending]);

  // History is fetched when a thread is first opened, not up front: most
  // sessions only ever touch the newest one.
  useEffect(() => {
    if (!open || !threadId || loadedThreadRef.current === threadId) return;
    loadedThreadRef.current = threadId;
    startTransition(async () => {
      try {
        setMessages(await loadAssistantThreadAction(threadId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load that conversation.");
      }
    });
  }, [open, threadId]);

  async function ensureThread(): Promise<string> {
    if (threadId) return threadId;
    const thread = await startAssistantThreadAction(departmentCode);
    loadedThreadRef.current = thread.id;
    setThreads((prev) => [thread, ...prev]);
    setThreadId(thread.id);
    return thread.id;
  }

  function send(text: string) {
    const content = text.trim();
    if (!content || isPending) return;
    setError(null);
    setMessages((prev) => [...prev, { id: `pending-${Date.now()}`, role: "user", content }]);
    setInput("");
    startTransition(async () => {
      try {
        const id = await ensureThread();
        const reply = await sendAssistantMessageAction(id, content);
        setMessages((prev) => [...prev, reply]);
        setThreads(await listAssistantThreadsAction(departmentCode));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong sending that.");
      }
    });
  }

  function newThread() {
    setThreadId(null);
    loadedThreadRef.current = null;
    setMessages([]);
    setShowThreads(false);
    setError(null);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open the ${label} assistant`}
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
        maximized ? "h-[85vh] w-[32rem] max-w-[calc(100vw-2.5rem)]" : "h-[32rem] w-96 max-w-[calc(100vw-2.5rem)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2 bg-brand-black px-4 py-3 text-white">
        <span className="truncate text-sm font-medium">{label} assistant</span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={newThread}
            className="rounded px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            New chat
          </button>
          <button
            type="button"
            onClick={() => setShowThreads((v) => !v)}
            className="rounded px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
            aria-expanded={showThreads}
          >
            History ({threads.length})
          </button>
          <button
            type="button"
            onClick={() => setMaximized((v) => !v)}
            aria-label={maximized ? "Restore assistant" : "Maximize assistant"}
            className="rounded p-1.5 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Minimize assistant"
            className="rounded p-1.5 text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {showThreads && (
        <div className="max-h-44 overflow-y-auto border-b border-neutral-200 bg-neutral-50">
          {threads.length === 0 ? (
            <p className="px-4 py-3 text-xs text-neutral-500">No conversations yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-200">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setThreadId(t.id);
                      setShowThreads(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-xs hover:bg-white ${
                      t.id === threadId ? "font-semibold text-neutral-900" : "text-neutral-600"
                    }`}
                  >
                    <span className="truncate">{t.title ?? "New conversation"}</span>
                    <span className="shrink-0 text-neutral-400">{relativeDay(t.lastMessageAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto px-3.5 py-4">
        {messages.length === 0 ? (
          <div className="px-1 py-2">
            <p className="mb-3 text-sm text-neutral-500">{description}</p>
            <ul className="flex flex-col gap-1.5">
              {suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => send(s)}
                    disabled={isPending}
                    className="w-full rounded-md border border-neutral-200 px-3 py-2 text-left text-sm text-neutral-700 hover:border-neutral-400 disabled:opacity-60"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.role === "user" ? "self-end bg-brand-black text-white" : "self-start bg-neutral-100 text-neutral-900"
                }`}
              >
                {m.role === "user" ? (
                  <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                ) : (
                  <ReactMarkdown components={chatMarkdownComponents}>{m.content}</ReactMarkdown>
                )}
              </div>
            ))}
          </div>
        )}
        {isPending && <p className="mt-3 text-xs text-neutral-400">Thinking…</p>}
        {error && <p className="mt-3 text-xs text-red-700">{error}</p>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-end gap-2 border-t border-neutral-200 p-3"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={2}
          placeholder={`Ask about your ${label.toLowerCase()} work…`}
          className="min-h-0 flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isPending || input.trim().length === 0}
          className="rounded-md bg-brand-black px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          Send
        </button>
      </form>
    </div>
  );
}
