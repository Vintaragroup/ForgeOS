import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "./logout/actions";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ForgeOS",
  description: "ForgeOS — CRM & opportunity shell",
};

const NAV_LINKS = [
  { href: "/opportunities", label: "Opportunities" },
  { href: "/companies", label: "Companies" },
  { href: "/contacts", label: "Contacts" },
  { href: "/users", label: "Users" },
  { href: "/catalog", label: "Catalog" },
];

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  const isAdmin = user?.systemRole === "ADMIN" || user?.systemRole === "SUPER_ADMIN";
  const navLinks = isAdmin ? [...NAV_LINKS, { href: "/admin", label: "Admin" }] : NAV_LINKS;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center gap-8 px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              ForgeOS
            </Link>
            <nav className="flex flex-1 gap-6 text-sm font-medium text-neutral-600">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="hover:text-neutral-900"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
            {user && (
              <div className="flex items-center gap-3 text-sm text-neutral-600">
                <span>{user.name}</span>
                <form action={logoutAction}>
                  <button type="submit" className="font-medium hover:text-neutral-900">
                    Log out
                  </button>
                </form>
              </div>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
