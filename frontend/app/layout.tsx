import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TranslationProvider } from "@/lib/i18n";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "iPartner Media Manager: Coperon's DAM Solution",
  description: "Coperon's digital asset management platform for uploading, organizing, and sharing media with clients.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Blocking (no defer/async) and runs before first paint, so the
            dark-mode class and locale the user last chose are already applied
            by the time anything renders — without this, every returning user
            would see a flash of the default (light theme / English) on every
            load. One script, two independent try/catch blocks so a failure
            in one (private browsing, corrupted value) can't block the other;
            each falls back to its own default (light / "en"). The locale
            block doesn't hardcode "en"/"it" anywhere — it just mirrors
            whatever's in localStorage onto <html>, so adding a language
            (lib/i18n.tsx's LOCALES list + locales/<code>.json) never needs a
            change here. Reads the same localStorage keys AppShell's toggle
            and the account-menu language selector write. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("dam:theme");if(t==="dark"){document.documentElement.dataset.theme="dark";}}catch(e){}try{var l=localStorage.getItem("dam:locale")||"en";document.documentElement.lang=l;document.documentElement.dataset.locale=l;}catch(e){document.documentElement.lang="en";document.documentElement.dataset.locale="en";}})();`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <TranslationProvider>{children}</TranslationProvider>
      </body>
    </html>
  );
}
