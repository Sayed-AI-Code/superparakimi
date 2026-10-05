import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";

import { auth, signOut } from "@/lib/auth";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "superparakimi",
  description: "Paraphrase text with control over mode and strength.",
};

// Rendered under Suspense so the static shell streams while the session
// (JWT cookie) is read — see "Auth and streaming" in the Next.js guide.
async function SiteNav() {
  const session = await auth();

  return (
    <nav className="flex items-center justify-between gap-4 border-b border-black/10 px-6 py-3 dark:border-white/10">
      <Link
        href="/"
        className="font-mono text-sm font-semibold tracking-tight text-black dark:text-zinc-50"
      >
        superparakimi
      </Link>
      <div className="flex items-center gap-4 text-sm">
        {session?.user ? (
          <>
            {/* Task 10 fills this slot with the usage meter. */}
            <div id="usage-meter-slot" />
            <span className="hidden text-zinc-600 sm:inline dark:text-zinc-400">
              {session.user.email ?? session.user.name}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="rounded-full border border-black/10 px-4 py-1.5 font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]"
              >
                Sign out
              </button>
            </form>
          </>
        ) : (
          <>
            <Link href="/signup" className="text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50">
              Sign up
            </Link>
            <Link
              href="/signin"
              className="rounded-full bg-black px-4 py-1.5 font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              Sign in
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Suspense
          fallback={
            <div className="border-b border-black/10 px-6 py-3 dark:border-white/10" />
          }
        >
          <SiteNav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
