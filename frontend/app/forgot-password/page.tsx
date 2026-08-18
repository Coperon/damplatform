"use client";

import { useState } from "react";
import Link from "next/link";
import AuthShell, {
  authLabelClass,
  authInputClass,
  authButtonClass,
  authMessageClass,
  authLinkClass,
  authBackLinkClass,
} from "@/components/AuthShell";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  async function handleSubmit() {
    if (!email) {
      setMessage("Please enter your email.");
      return;
    }

    setMessage("Sending...");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json().catch(() => null);
      // The backend always returns the same neutral message on purpose.
      setMessage(data?.message ?? "If that email is registered, a reset link has been sent.");
    } catch {
      setMessage("Could not reach the server.");
    }
  }

  return (
    <AuthShell
      heading="Reset your password"
      subtext="Enter your email and we'll send you a reset link."
    >
      <label htmlFor="forgot-email" className={authLabelClass}>
        Email
      </label>
      <input
        id="forgot-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={`${authInputClass} mb-6`}
      />

      <button onClick={handleSubmit} className={authButtonClass}>
        Send reset link
      </button>

      {message && <p className={authMessageClass}>{message}</p>}

      <p className="mt-6 text-center text-sm text-slate">
        <Link href="/" className={authLinkClass}>
          Back to login
        </Link>
      </p>

      <Link href="/" className={authBackLinkClass}>
        ← Back to sign in
      </Link>
    </AuthShell>
  );
}
