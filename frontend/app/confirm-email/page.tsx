"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AuthShell, {
  authButtonClass,
  authMessageClass,
  authLinkClass,
  authBackLinkClass,
} from "@/components/AuthShell";
import { useTranslation, interpolateJSX } from "@/lib/i18n";

type Status = "loading" | "invalid" | "ready" | "success";

// The confirmation step deliberately requires an explicit click, not an
// automatic action on page load — GET /api/profile/email-change/validate is
// read-only (never marks the token used) precisely so an email client's
// link-prescanner opening this page can't itself burn the single-use token
// before the real person clicks "Confirm change." Public route: this link
// is emailed to the NEW address, which may not be logged in on this device
// at all.
function ConfirmEmailForm() {
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  const token = searchParams.get("token") ?? "";

  const [status, setStatus] = useState<Status>("loading");
  const [newEmail, setNewEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    let cancelled = false;
    fetch(`/api/profile/email-change/validate?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((body: { status: string; newEmail?: string }) => {
        if (cancelled) return;
        if (body.status === "valid" && body.newEmail) {
          setNewEmail(body.newEmail);
          setStatus("ready");
        } else {
          setStatus("invalid");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    setError("");
    try {
      const res = await fetch("/api/profile/email-change/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The atomic re-check inside confirmEmailChange is authoritative — the
        // link could have been cancelled, expired, or already used since this
        // page loaded. Anything other than the address-conflict case falls
        // back to the same generic invalid screen shown on a dead link.
        if (body.error && String(body.error).includes("already in use")) {
          setError(body.error);
        } else {
          setStatus("invalid");
        }
        return;
      }
      setStatus("success");
    } catch {
      setError(t("common.error.couldNotReachServer"));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <AuthShell
      heading={status === "success" ? t("confirmEmail.success.heading") : t("confirmEmail.heading")}
      subtext={status === "ready" ? t("confirmEmail.readySubtext", { email: newEmail }) : undefined}
    >
      {status === "loading" && <p className="text-center text-sm text-slate">{t("confirmEmail.checkingLink")}</p>}

      {status === "invalid" && (
        <>
          <p className="text-center text-sm text-slate">
            {t("confirmEmail.invalid.message")}
          </p>
          <Link href="/" className={authBackLinkClass}>
            {t("confirmEmail.backToSignIn")}
          </Link>
        </>
      )}

      {status === "ready" && (
        <>
          <button onClick={handleConfirm} disabled={confirming} className={authButtonClass}>
            {confirming ? t("confirmEmail.confirming") : t("confirmEmail.confirmSubmit")}
          </button>
          {error && <p className={authMessageClass}>{error}</p>}
          <Link href="/" className={authBackLinkClass}>
            {t("confirmEmail.backToSignIn")}
          </Link>
        </>
      )}

      {status === "success" && (
        <>
          <p className="text-center text-sm text-slate">
            {interpolateJSX(t("confirmEmail.success.message"), {
              email: <span className="font-medium text-ink">{newEmail}</span>,
            })}
          </p>
          <p className="mt-4 text-center text-sm">
            <Link href="/" className={authLinkClass}>
              {t("common.goToLogin")}
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}

export default function ConfirmEmailPage() {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <AuthShell heading={t("confirmEmail.heading")}>
          <p className="text-center text-sm text-slate">{t("common.loading")}</p>
        </AuthShell>
      }
    >
      <ConfirmEmailForm />
    </Suspense>
  );
}
