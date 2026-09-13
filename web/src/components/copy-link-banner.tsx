"use client";

import { useRef, useState } from "react";

// Renders once, right after a fresh client-portal invite -- see
// notifyClientInvited's own comment for why: only the invite's tokenHash is
// ever persisted, so the raw link in the URL that got this page rendered is
// the only chance anyone has to recover it. Reloading this page without
// ?invite= (or navigating away and back) won't bring it back; a brand new
// invite would need to be issued instead.
export function CopyLinkBanner({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  return (
    <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="mb-2 text-sm font-medium text-amber-900">
        Client portal link — copy this now and send it to the client yourself. Email delivery isn&apos;t working
        yet, and this link won&apos;t be shown again after you leave this page.
      </p>
      <div className="flex items-center gap-2">
        <code ref={codeRef} className="flex-1 overflow-x-auto rounded border border-amber-200 bg-white px-3 py-2 text-xs text-neutral-800">
          {link}
        </code>
        <button
          type="button"
          onClick={async () => {
            const selectFallback = () => {
              const range = document.createRange();
              if (codeRef.current) {
                range.selectNodeContents(codeRef.current);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
              }
            };
            try {
              // navigator.clipboard.writeText can hang indefinitely rather
              // than reject -- e.g. a stuck permission prompt, or a policy
              // silently blocking clipboard access -- so this is raced
              // against a timeout rather than just awaited directly; either
              // way (rejection or timeout) falls back to selecting the text
              // so a manual Cmd/Ctrl+C still works instead of the click
              // just doing nothing with no explanation.
              await Promise.race([
                navigator.clipboard.writeText(link),
                new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 1500)),
              ]);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              selectFallback();
            }
          }}
          className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
