"use client";

import { useEffect, useRef, useState } from "react";

// The same open/outside-click/Escape-close behavior was hand-copied across
// booth-actions-menu.tsx, section-move-menu.tsx, and
// element-group-actions-menu.tsx -- identical effect bodies, only the
// trigger/panel markup differed between them. One shared hook now backs
// all three (and any future kebab-menu popover), leaving each caller free
// to keep its own visual (dark booth header vs. light catalog card).
export function useDismissableMenu<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return { open, setOpen, containerRef };
}
