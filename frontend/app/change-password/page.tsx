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

export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");

  async function handleChange() {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage("Please fill in all fields.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("New passwords do not match.");
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

    const token = localStorage.getItem("token");
    if (!token) {
      setMessage("You must be logged in to change your password.");
      return;
    }

    setMessage("Updating password...");
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessage(data?.message ?? "Could not change password.");
        return;
      }

      setMessage("Password changed successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setMessage("Could not reach the server.");
    }
  }

  return (
    <AuthShell
      heading="Change password"
      subtext="Update the password for your account."
    >
      <label htmlFor="change-current-password" className={authLabelClass}>
        Current password
      </label>
      <input
        id="change-current-password"
        type="password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        className={`${authInputClass} mb-4`}
      />

      <label htmlFor="change-new-password" className={authLabelClass}>
        New password
      </label>
      <input
        id="change-new-password"
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        className={`${authInputClass} mb-4`}
      />

      <label htmlFor="change-confirm-password" className={authLabelClass}>
        Confirm new password
      </label>
      <input
        id="change-confirm-password"
        type="password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        className={`${authInputClass} mb-6`}
      />

      <button onClick={handleChange} className={authButtonClass}>
        Update password
      </button>

      {message && <p className={authMessageClass}>{message}</p>}

      <p className="mt-6 text-center text-sm text-slate">
        <Link href="/" className={authLinkClass}>
          Back to login
        </Link>
      </p>
      <p className="mt-2 text-center text-sm text-slate">
        <Link href="/forgot-password" className={authLinkClass}>
          Forgot password?
        </Link>
      </p>

      <Link href="/" className={authBackLinkClass}>
        ← Back to sign in
      </Link>
    </AuthShell>
  );
}
