"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { Modal } from "@/components/modal";

// Open/closed state lives in the URL (`?<openParam>=1`), not local React
// state -- matches Tabs.tsx's own reasoning for URL-synced state: a
// "+ Client" or "+ Create Order" button is then a plain server-rendered
// Link, no client JS needed just to open it, and the multi-step "Start an
// artwork order" flow (pick an opportunity via a GET form, then see the
// contact picker) can keep adding its own query params -- e.g.
// ?opportunityId=... -- without the modal closing, since the whole thing
// re-renders from the URL on every step rather than living in memory that
// a fresh page load would forget.
export function DashboardActionModal({
  title,
  openParam,
  openValue,
  clearParams,
  children,
}: {
  title: string;
  openParam: string;
  // The exact value openParam must equal for THIS modal to show -- not
  // just present. Two modals sharing one param name (e.g. both keyed off
  // ?openAction=...) but checked only for presence would both open
  // whenever either one's trigger link was clicked.
  openValue: string;
  // Every query param to strip on close, not just openParam itself -- e.g.
  // the "Create order" modal also owns `opportunityId` once a user has
  // picked one, and closing should reset that too rather than leaving a
  // stale selection for next time it's opened.
  clearParams: string[];
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (searchParams.get(openParam) !== openValue) return null;

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of clearParams) params.delete(key);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <Modal title={title} onClose={close}>
      <div className="p-5">{children}</div>
    </Modal>
  );
}
