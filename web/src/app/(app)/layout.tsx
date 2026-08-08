import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Geist, Geist_Mono, Bebas_Neue } from "next/font/google";
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

// Substitute for the brand guide's licensed "Bebas Neue Pro SemiExpanded" --
// we don't have that font file, so we use the free single-weight Bebas Neue
// from Google Fonts, which is visually very close.
const bebasNeue = Bebas_Neue({
  variable: "--font-bebas-neue",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ForgeOS",
  description: "ForgeOS — CRM & opportunity shell",
};

const NAV_LINKS = [
  { href: "/opportunities", label: "Opportunities" },
  { href: "/estimates", label: "Estimates" },
  { href: "/proposals", label: "Proposals" },
  { href: "/projects", label: "Projects" },
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
      className={`${geistSans.variable} ${geistMono.variable} ${bebasNeue.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900">
        <header className="bg-brand-black text-white">
          <div className="mx-auto flex max-w-5xl items-center gap-8 px-6 py-4">
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
            <nav className="flex flex-1 gap-6 text-sm font-medium text-neutral-300">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="transition-colors hover:text-brand-teal-light"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
            {user && (
              <div className="flex items-center gap-3 text-sm text-neutral-300">
                <span>{user.name}</span>
                <form action={logoutAction}>
                  <button
                    type="submit"
                    className="font-medium transition-colors hover:text-brand-tangerine"
                  >
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
