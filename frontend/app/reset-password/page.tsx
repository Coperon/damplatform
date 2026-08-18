"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AuthShell, {
  authLabelClass,
  authInputClass,
  authButtonClass,
  authMessageClass,
  authLinkClass,
  authBackLinkClass,
} from "@/components/AuthShell";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);

  async function handleReset() {
    if (!token) {
      setMessage("This reset link is invalid or incomplete.");
      return;
    }
    if (!newPassword || !confirmPassword) {
      setMessage("Please fill in both password fields.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }
    const strong =
      newPassword.length >= 8 &&
      /[A-Z]/.test(newPassword) &&
      /[a-z]/.test(newPassword) &&
      /[0-9]/.test(newPassword) &&
      /[^A-Za-z0-9]/.test(newPassword);
    if (!strong) {
      setMessage(
        "Password must be 8+ characters with an uppercase, lowercase, number, and special character."
      );
      return;
    }

    setMessage("Resetting...");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessage(data?.message ?? "Could not reset password.");
        return;
      }

      setDone(true);
      setMessage("Password has been reset.");
    } catch {
      setMessage("Could not reach the server.");
    }
  }

  return (
    <AuthShell heading="Set a new password" subtext="Choose a new password for your account.">
      <label htmlFor="reset-new-password" className={authLabelClass}>
        New password
      </label>
      <input
        id="reset-new-password"
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        className={`${authInputClass} mb-4`}
      />

      <label htmlFor="reset-confirm-password" className={authLabelClass}>
        Confirm new password
      </label>
      <input
        id="reset-confirm-password"
        type="password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        className={`${authInputClass} mb-6`}
      />

      <button onClick={handleReset} className={authButtonClass}>
        Save password
      </button>

      {message && <p className={authMessageClass}>{message}</p>}

      {done && (
        <p className="mt-2 text-center text-sm">
          <Link href="/" className={authLinkClass}>
            Go to login
          </Link>
        </p>
      )}

      <Link href="/" className={authBackLinkClass}>
        ← Back to sign in
      </Link>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthShell heading="Set a new password">
          <p className="text-center text-sm text-slate">Loading…</p>
        </AuthShell>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
