"use client";

import { useEffect } from "react";

const STORAGE_KEY = "forgeos-dashboard-theme";

// Sets data-theme on the dashboard's own .dash wrapper (found via
// targetId), not <html> -- this is the only page with a light/dark
// toggle so far, and scoping it to one wrapper means it can never leak
// into any other page's fixed brand-* colors. Defaults to the visitor's
// system preference on first load, then remembers whatever they pick
// after that, the same per-viewer-convenience use of localStorage as
// everywhere else in this app that doesn't need a synced, cross-device
// preference.
//
// No React state for "is it dark" -- the DOM attribute IS the state
// (globals.css keys every dash-* rule, including which sun/moon icon
// shows, off .dash[data-theme]), so toggle() just reads and flips it
// directly. Deliberately not read into useState during the mount effect
// either: localStorage/matchMedia only exist client-side, so setting
// that into React state on mount would still have to happen after
// hydration -- the DOM write below already achieves the same "set once
// we know the real preference" result without a synchronous setState in
// an effect.
export function ThemeToggle({ targetId }: { targetId: string }) {
  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private browsing / storage blocked -- fall back to system preference below.
    }
    const isDark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    target.setAttribute("data-theme", isDark ? "dark" : "light");
  }, [targetId]);

  function toggle() {
    const target = document.getElementById(targetId);
    if (!target) return;
    const next = target.getAttribute("data-theme") === "dark" ? "light" : "dark";
    target.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Nothing to persist to -- the toggle still works for this visit.
    }
  }

  return (
    <button type="button" className="dash-theme-toggle" onClick={toggle} aria-label="Toggle dark mode">
      <svg
        className="dash-icon-sun"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      <svg
        className="dash-icon-moon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    </button>
  );
}
