"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

// Groups with a single item render as a plain link (a 1-item dropdown reads
// oddly); groups with 2+ render as a hover/focus dropdown. Desktop dropdowns
// are pure CSS (group-hover/group-focus-within) -- only the mobile drawer
// needs JS state, since touch has no hover.
export function AppNav({
  groups,
  adminLink,
  userName,
  logoutAction,
}: {
  groups: NavGroup[];
  adminLink: NavItem | null;
  userName: string | null;
  logoutAction: (formData: FormData) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const groupActive = (group: NavGroup) => group.items.some((item) => isActive(item.href));

  return (
    <>
      <div className="mx-auto flex max-w-6xl items-center gap-8 px-6 py-4">
        <Link href="/" className="flex flex-col gap-1">
          <Image
            src="/brand/expo-logo-white.png"
            alt="Expo Convention Contractors"
            width={112}
            height={38}
            priority
            className="h-7 w-auto"
          />
          <span className="text-[10px] font-medium uppercase tracking-widest text-neutral-500">
            Powered by ForgeOS
          </span>
        </Link>

        <nav className="hidden flex-1 items-center gap-1 text-sm font-medium text-neutral-300 lg:flex">
          {groups.map((group) =>
            group.items.length === 1 ? (
              <Link
                key={group.label}
                href={group.items[0].href}
                className={`rounded-md px-3 py-2 transition-colors hover:text-brand-teal-light ${
                  groupActive(group) ? "text-brand-teal-light" : ""
                }`}
              >
                {group.items[0].label}
              </Link>
            ) : (
              <div key={group.label} className="group relative">
                <button
                  type="button"
                  className={`flex items-center gap-1 rounded-md px-3 py-2 transition-colors hover:text-brand-teal-light ${
                    groupActive(group) ? "text-brand-teal-light" : ""
                  }`}
                >
                  {group.label}
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div className="invisible absolute left-0 top-full z-20 pt-1 opacity-0 transition-opacity duration-100 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                  <div className="flex w-52 flex-col rounded-md border border-white/10 bg-brand-black py-1.5 shadow-xl">
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`px-3.5 py-2 text-sm transition-colors hover:bg-white/5 hover:text-brand-teal-light ${
                          isActive(item.href) ? "text-brand-teal-light" : "text-neutral-300"
                        }`}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ),
          )}
          {adminLink && (
            <Link
              href={adminLink.href}
              className={`ml-2 rounded-md border-l border-white/10 px-3 py-2 pl-4 transition-colors hover:text-brand-tangerine ${
                isActive(adminLink.href) ? "text-brand-tangerine" : ""
              }`}
            >
              {adminLink.label}
            </Link>
          )}
        </nav>

        <form action="/search" method="GET" className="hidden lg:block">
          <label className="sr-only" htmlFor="global-search">
            Search
          </label>
          <div className="relative">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              id="global-search"
              type="search"
              name="q"
              placeholder="Search…"
              className="w-40 rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-2.5 text-sm text-neutral-100 placeholder:text-neutral-500 transition-colors focus:w-56 focus:border-white/20 focus:bg-white/10 focus:outline-none"
            />
          </div>
        </form>

        {userName && (
          <div className="group relative hidden lg:block">
            <button
              type="button"
              aria-label={`Account menu for ${userName}`}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-neutral-100 transition-colors hover:bg-white/20"
            >
              {initials(userName)}
            </button>
            <div className="invisible absolute right-0 top-full z-20 pt-1 opacity-0 transition-opacity duration-100 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
              <div className="flex w-44 flex-col rounded-md border border-white/10 bg-brand-black py-1.5 shadow-xl">
                <div className="truncate px-3.5 py-1.5 text-sm text-neutral-400">{userName}</div>
                <Link
                  href="/account"
                  className="px-3.5 py-2 text-sm text-neutral-300 transition-colors hover:bg-white/5 hover:text-brand-teal-light"
                >
                  Change password
                </Link>
                <form action={logoutAction}>
                  <button
                    type="submit"
                    className="w-full px-3.5 py-2 text-left text-sm text-neutral-300 transition-colors hover:bg-white/5 hover:text-brand-tangerine"
                  >
                    Log out
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="ml-auto flex h-10 w-10 items-center justify-center rounded-md text-neutral-300 hover:text-white lg:hidden"
        >
          {mobileOpen ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      {mobileOpen && (
        <nav className="border-t border-white/10 px-4 pb-4 lg:hidden">
          <form action="/search" method="GET" className="py-3">
            <label className="sr-only" htmlFor="global-search-mobile">
              Search
            </label>
            <input
              id="global-search-mobile"
              type="search"
              name="q"
              placeholder="Search…"
              className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-base text-neutral-100 placeholder:text-neutral-500 focus:border-white/20 focus:bg-white/10 focus:outline-none"
            />
          </form>
          {groups.map((group) => (
            <div key={group.label} className="border-b border-white/10 py-3">
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
                {group.label}
              </div>
              <div className="flex flex-col">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`rounded-md px-2 py-2.5 text-base transition-colors ${
                      isActive(item.href) ? "text-brand-teal-light" : "text-neutral-200 hover:text-white"
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
          {adminLink && (
            <Link
              href={adminLink.href}
              onClick={() => setMobileOpen(false)}
              className={`block rounded-md px-2 py-3 text-base font-medium ${
                isActive(adminLink.href) ? "text-brand-tangerine" : "text-neutral-200"
              }`}
            >
              {adminLink.label}
            </Link>
          )}
          {userName && (
            <div className="flex flex-col gap-2 px-2 pt-3 text-sm text-neutral-300">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-neutral-100">
                  {initials(userName)}
                </span>
                <span>{userName}</span>
              </div>
              <div className="flex items-center justify-between pl-[2.625rem]">
                <Link
                  href="/account"
                  onClick={() => setMobileOpen(false)}
                  className="font-medium text-neutral-200 hover:text-brand-teal-light"
                >
                  Change password
                </Link>
                <form action={logoutAction}>
                  <button type="submit" className="font-medium text-neutral-200 hover:text-brand-tangerine">
                    Log out
                  </button>
                </form>
              </div>
            </div>
          )}
        </nav>
      )}
    </>
  );
}
