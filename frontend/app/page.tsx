"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Inter, Manrope } from "next/font/google";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"] });
const manrope = Manrope({ subsets: ["latin"], weight: ["600", "700"] });

// Left-panel background candidate. Swap to "/login-mm2.jpg" to compare the dotted-network pattern.
const LOGIN_BG = "/login-mm2.jpg";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function handleLogin() {
    setMessage("Logging in...");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        setMessage("Login failed: invalid email or password.");
        return;
      }

      const data = await res.json();
      localStorage.setItem("token", data.access_token);
      router.push("/home");
    } catch {
      setMessage("Could not reach the server.");
    }
  }

  return (
    <div className={`${inter.className} flex min-h-screen flex-col lg:flex-row`}>
      {/* Illustration panel */}
      <div className="relative h-28 w-full shrink-0 overflow-hidden lg:h-auto lg:min-h-screen lg:w-[55%]">
        <img
          src={LOGIN_BG}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* Wordmark — top-left, directly on the illustration in its natural blue */}
        <div className="absolute left-4 top-4 z-10 inline-flex w-fit lg:left-8 lg:top-8">
          <img src="/coperon-technologies.png" alt="Coperon Technologies" className="h-auto w-[150px]" />
        </div>

        {/* Legibility guard — the bottom-left corner gets busy/darker on both background candidates; a soft
            white falloff lifts the tagline without a visible edge. Top-left stays plain (no guard needed there). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 z-[5] hidden h-[320px] w-[480px] lg:block"
          style={{
            background:
              "radial-gradient(circle at 0% 100%, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.18) 35%, rgba(255,255,255,0) 70%)",
          }}
        />

        {/* Tagline — bottom-left; hidden on mobile where the panel collapses to a short strip */}
        <div
          className={`${manrope.className} absolute bottom-8 left-8 z-10 hidden text-[26px] font-bold leading-[1.15] text-brand lg:block`}
        >
          <p>iPartner Media Manager:</p>
          <p>Coperon&apos;s DAM Solution</p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-mist px-6 py-12">
        <div className="w-full max-w-[380px]">
          <h1
            className={`${manrope.className} text-[28px] font-bold tracking-[-0.01em] text-ink`}
          >
            Sign in
          </h1>
          <p className="mt-2 text-sm text-slate">
            Access your Coperon asset library
          </p>

          <div className="mt-8">
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-[13px] font-medium text-slate"
            >
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-[46px] w-full rounded-[10px] border border-line bg-card px-3.5 text-[15px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>

          <div className="mt-4">
            <label
              htmlFor="login-password"
              className="mb-1.5 block text-[13px] font-medium text-slate"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-[46px] w-full rounded-[10px] border border-line bg-card px-3.5 text-[15px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>

          <button
            onClick={handleLogin}
            className="mt-6 h-[46px] w-full cursor-pointer rounded-[10px] bg-brand text-[15px] font-semibold text-white transition-[background-color,transform] hover:bg-brand-hover focus:outline-none focus:ring-[3px] focus:ring-brand/15 motion-safe:active:scale-[0.99]"
          >
            Log in
          </button>

          {message && (
            <p className="mt-4 text-center text-sm text-slate">{message}</p>
          )}

          <p className="mt-4 text-center text-sm">
            <Link
              href="/forgot-password"
              className="rounded font-medium text-brand hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Forgot password?
            </Link>
          </p>
          <p className="mt-2 text-center text-sm">
            <Link
              href="/change-password"
              className="rounded font-medium text-brand hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Change password
            </Link>
          </p>

          <div className="mt-6 flex items-center gap-3" aria-hidden="true">
            <div className="h-px flex-1 bg-line" />
            <span className="text-xs text-slate">or</span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <p className="mt-6 text-center text-sm text-slate">
            Contact your administrator for access
          </p>
        </div>
      </div>
    </div>
  );
}
