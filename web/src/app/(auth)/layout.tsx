import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, Bebas_Neue } from "next/font/google";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bebasNeue = Bebas_Neue({
  variable: "--font-bebas-neue",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Log in — ForgeOS",
  description: "ForgeOS — estimating, proposals, and production for Expo Convention Contractors",
};

// A separate root layout (Next's route-groups convention) rather than
// reusing (app)/layout.tsx's shell -- the login screen has no nav to show
// and no logged-in user yet, so it gets its own clean, on-brand page
// instead of the app chrome with an empty header.
//
// Full-bleed black background is the brand guide's own cover-page treatment
// (its signature rounded-corner black panels dominate every section divider
// in the guide) -- the one screen in the app where we lean all the way into
// that instead of using black/color only as accents.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bebasNeue.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-brand-black text-white">
        <main className="flex flex-1 items-center justify-center px-6 py-16">
          {children}
        </main>
      </body>
    </html>
  );
}
