import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "Log in — ForgeOS",
  description: "ForgeOS — estimating, proposals, and production for Expo Convention Contractors",
};

// A separate root layout (Next's route-groups convention) rather than
// reusing (app)/layout.tsx's shell -- the login screen has no nav to show
// and no logged-in user yet, so it gets its own clean, on-brand page
// instead of the app chrome with an empty header.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-neutral-50 text-neutral-900">
        <main className="flex flex-1 items-center justify-center px-6 py-16">
          {children}
        </main>
      </body>
    </html>
  );
}
