"use client";

import { Inter, Manrope } from "next/font/google";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"] });
const manrope = Manrope({ subsets: ["latin"], weight: ["600", "700"] });

// Shared style tokens so the four secondary auth pages (forgot/reset/change
// password, signup) stay visually identical to each other and to the login
// page without copy-pasting className strings four times over.
export const authLabelClass =
  "mb-1.5 block text-[13px] font-medium text-slate";

export const authInputClass =
  "h-11 w-full rounded-[10px] border border-line bg-card px-3.5 text-[15px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15";

export const authButtonClass =
  "h-[46px] w-full cursor-pointer rounded-[10px] bg-brand text-[15px] font-semibold text-white transition-[background-color,transform] hover:bg-brand-hover focus:outline-none focus:ring-[3px] focus:ring-brand/15 motion-safe:active:scale-[0.99]";

export const authMessageClass = "mt-4 text-center text-sm text-slate";

export const authLinkClass =
  "rounded font-medium text-brand hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

export const authBackLinkClass =
  "mt-6 block text-center text-[13px] font-medium text-brand hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded";

interface AuthShellProps {
  heading: string;
  subtext?: string;
  children: React.ReactNode;
}

export default function AuthShell({ heading, subtext, children }: AuthShellProps) {
  return (
    <div className={`${inter.className} flex min-h-screen flex-col bg-mist`}>
      <header className="flex h-[60px] w-full shrink-0 items-center justify-center bg-brand-dark">
        <img
          src="/coperon-technologies.png"
          alt="Coperon Technologies"
          className="h-auto w-[150px]"
          style={{ filter: "brightness(0) invert(1)" }}
        />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[380px] rounded-xl border border-line bg-card p-[30px]">
          <h1
            className={`${manrope.className} text-[23px] font-bold text-ink`}
          >
            {heading}
          </h1>
          {subtext && <p className="mt-1.5 text-sm text-slate">{subtext}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
