import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, Bebas_Neue } from "next/font/google";
import "../globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const bebasNeue = Bebas_Neue({ variable: "--font-bebas-neue", weight: "400", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Artwork Portal",
  description: "Submit artwork, review proofs, and track production status.",
};

// A separate root layout (same route-groups convention as (auth)/layout.tsx)
// -- these pages have no internal nav, no logged-in User, and are branded
// as Expo-only (the vendor-anonymity constraint reaches even this shell:
// nothing here should ever look like it belongs to a specific vendor).
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${bebasNeue.variable} h-full antialiased`}>
      <body className="min-h-full bg-neutral-50 text-neutral-900">
        <header className="border-b border-neutral-200 bg-white px-6 py-4">
          <span className="font-display text-xl tracking-wide">Expo Artwork Portal</span>
        </header>
        <main className="mx-auto max-w-3xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
