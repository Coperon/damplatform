"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Inter, Manrope } from "next/font/google";
import PhoneInput from "@/components/PhoneInput";
import { useTranslation, interpolateJSX } from "@/lib/i18n";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"] });
const manrope = Manrope({ subsets: ["latin"], weight: ["600", "700"] });

// Same illustration panel as app/page.tsx (the login page) — kept as its own
// constant here rather than imported, since the login page doesn't export it.
const LOGIN_BG = "/login-mm2.jpg";

// Mirrors app/page.tsx's own inline classes exactly (login doesn't use
// components/AuthShell.tsx's cousin-layout tokens, so this page doesn't
// either — it's meant to look like the *same* screen, not a relative).
const labelClass = "mb-1.5 block text-[13px] font-medium text-slate";
const inputClass =
  "h-[46px] w-full rounded-[10px] border border-line bg-card px-3.5 text-[15px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15";
const buttonClass =
  "mt-6 h-[46px] w-full cursor-pointer rounded-[10px] bg-brand text-[15px] font-semibold text-white transition-[background-color,transform] hover:bg-brand-hover focus:outline-none focus:ring-[3px] focus:ring-brand/15 motion-safe:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-brand";
const linkClass =
  "rounded font-medium text-brand hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

type PageStatus = "loading" | "invalid" | "valid" | "success";

interface ValidateResponse {
  email: string;
  tenantName: string;
  roleName: string;
}

// Mirrors lib/users.ts's validatePasswordStrength exactly (length 8+,
// upper/lower/digit/special) — that function isn't reachable from a client
// component, so the rule set is restated here and must be kept in sync with
// it by hand if the server rule ever changes. Labels are translation keys
// (+ optional interpolation params), resolved at render time via t() inside
// the component — this array itself stays a module-level constant with no
// dependency on the translation context, only the pure regex tests.
const PASSWORD_RULES: {
  key: string;
  labelKey: string;
  labelParams?: Record<string, number>;
  test: (pw: string) => boolean;
}[] = [
  { key: "length", labelKey: "common.passwordRule.length", labelParams: { n: 8 }, test: (pw) => pw.length >= 8 },
  { key: "upper", labelKey: "common.passwordRule.upper", test: (pw) => /[A-Z]/.test(pw) },
  { key: "lower", labelKey: "common.passwordRule.lower", test: (pw) => /[a-z]/.test(pw) },
  { key: "digit", labelKey: "common.passwordRule.digit", test: (pw) => /[0-9]/.test(pw) },
  { key: "special", labelKey: "common.passwordRule.special", test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

function passwordMeetsAllRules(pw: string) {
  return PASSWORD_RULES.every((r) => r.test(pw));
}

function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function Spinner() {
  return (
    <svg className="h-6 w-6 animate-spin text-brand" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 text-slate" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" />
      <path d="M6.5 9V6.5a3.5 3.5 0 017 0V9" strokeLinecap="round" />
    </svg>
  );
}

function RuleCheck({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={`flex items-center text-xs ${done ? "text-brand" : "text-slate"}`}>
      <span
        className={`mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none ${
          done ? "border-brand bg-brand text-white" : "border-line text-transparent"
        }`}
        aria-hidden="true"
      >
        ✓
      </span>
      {label}
    </li>
  );
}

// The backend collapses every token failure (not-found, bad token, expired,
// already-accepted — including a link that was valid on load but got
// redeemed/expired before this exact submit) into this one exact message,
// both from the pre-check in GET /validate and from the atomic UPDATE race
// inside POST /redeem. Matching on it verbatim is what lets this page tell
// "your token is dead, here's the generic invalid screen" apart from "you
// mistyped your password, fix it and try again" without the server needing
// a separate error code.
const INVITE_INVALID_MESSAGE = "This invitation link is invalid or has expired.";

export default function InvitePage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation();
  const token = params.token as string;

  const [status, setStatus] = useState<PageStatus>("loading");
  const [invite, setInvite] = useState<ValidateResponse | null>(null);

  // "Your details" — the invited person's own name/phone. Tenant details
  // (address/phone) are no longer collected at redemption; the super admin
  // enters them at tenant creation instead.
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/invitations/validate/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && body.status === "valid") {
          setInvite(body as ValidateResponse);
          setStatus("valid");
        } else {
          // Generic failure — never surfaces whether this was not-found, a
          // bad token, expired, or already-accepted (matches the backend's
          // own no-oracle discipline).
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

  const passwordsMatch = confirmPassword.length === 0 || password === confirmPassword;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !invite) return;
    setFormError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError(t("invite.form.error.nameRequired"));
      return;
    }
    // phone is already the composed "+<dial> <number>" string PhoneInput
    // emits (or "" if no digits were typed) — nothing left to trim/compose here.
    if (!phone) {
      setFormError(t("invite.form.error.phoneRequired"));
      return;
    }
    if (!passwordMeetsAllRules(password)) {
      setFormError(t("invite.form.error.passwordRequirements"));
      return;
    }
    if (password !== confirmPassword) {
      setFormError(t("common.passwordsMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/invitations/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No email field — the server takes it from the invite, never the
        // request body.
        body: JSON.stringify({ token, name: trimmedName, phone, password }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        // Redemption mints a session exactly like a normal login (same
        // claims/signing, see lib/auth.ts's mintSessionToken) — store it the
        // same way app/page.tsx's login form does and go straight into the
        // app instead of sending the user back to sign in manually.
        if (body.access_token) {
          localStorage.setItem("token", body.access_token);
        }
        setStatus("success");
        setTimeout(() => router.push("/home"), 1200);
        return;
      }

      if (body.error === INVITE_INVALID_MESSAGE) {
        // The token re-check inside /redeem is authoritative — someone else
        // (or a second tab) could have redeemed/it could have expired since
        // this page loaded. Same generic screen as an invalid link on load.
        setStatus("invalid");
        return;
      }

      // Anything else (weak password, missing name, duplicate email) is a
      // fixable input mistake — shown inline, not the full-page invalid state.
      setFormError(body.error || t("invite.form.error.createFailed"));
    } catch {
      setFormError(t("common.error.couldNotReachServer"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`${inter.className} flex min-h-screen flex-col lg:flex-row`}>
      {/* Illustration panel — identical to app/page.tsx */}
      <div className="relative h-28 w-full shrink-0 overflow-hidden lg:h-auto lg:min-h-screen lg:w-[55%]">
        <img src={LOGIN_BG} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover" />

        <div className="absolute left-4 top-4 z-10 inline-flex w-fit lg:left-8 lg:top-8">
          <img src="/coperon-technologies.png" alt="Coperon Technologies" className="h-auto w-[150px]" />
        </div>

        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 z-[5] hidden h-[320px] w-[480px] lg:block"
          style={{
            background:
              "radial-gradient(circle at 0% 100%, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.18) 35%, rgba(255,255,255,0) 70%)",
          }}
        />

        <div
          className={`${manrope.className} absolute bottom-8 left-8 z-10 hidden text-[26px] font-bold leading-[1.15] text-brand lg:block`}
        >
          <p>iPartner Media Manager:</p>
          <p>Coperon&apos;s DAM Solution</p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-mist px-6 py-12">
        <div className="w-full max-w-[420px]">
          {status === "loading" && (
            <div className="flex flex-col items-center justify-center gap-3 py-20">
              <Spinner />
              <p className="text-sm text-slate">{t("invite.loading")}</p>
            </div>
          )}

          {status === "invalid" && (
            <div className="text-center">
              <h1 className={`${manrope.className} text-[26px] font-bold text-ink`}>
                {t("invite.invalid.title")}
              </h1>
              <p className="mt-2 text-sm text-slate">
                {t("invite.invalid.message")}
              </p>
              <p className="mt-6 text-sm">
                <Link href="/" className={linkClass}>
                  {t("common.goToLogin")}
                </Link>
              </p>
            </div>
          )}

          {status === "success" && (
            <div className="text-center">
              <h1 className={`${manrope.className} text-[26px] font-bold text-ink`}>{t("invite.success.title")}</h1>
              <p className="mt-2 text-sm text-slate">{t("invite.success.message")}</p>
            </div>
          )}

          {status === "valid" && invite && (
            <form onSubmit={handleSubmit}>
              <h1 className={`${manrope.className} text-[28px] font-bold tracking-[-0.01em] text-ink`}>
                {t("invite.form.heading")}
              </h1>
              <p className="mt-2 text-sm text-slate">
                {interpolateJSX(t("invite.form.invitedTo"), {
                  tenant: <span className="font-medium text-ink">{invite.tenantName}</span>,
                  role: <span className="font-medium text-ink">{capitalize(invite.roleName)}</span>,
                })}
              </p>

              {/* Email — locked/prefilled from validate. Deliberately not an
                  <input> at all (not even disabled) so it can never be mistaken
                  for editable, and it is never included in the redeem body. */}
              <div className="mt-6">
                <span className={labelClass}>{t("common.email")}</span>
                <div className="flex h-[46px] w-full items-center justify-between rounded-[10px] border border-line bg-mist px-3.5 text-[15px] text-slate">
                  <span className="truncate">{invite.email}</span>
                  <LockIcon />
                </div>
                <p className="mt-1 text-xs text-slate">{t("invite.form.emailLocked")}</p>
              </div>

              <div className="mt-4">
                <label htmlFor="invite-name" className={labelClass}>
                  {t("common.name")}
                </label>
                <input
                  id="invite-name"
                  type="text"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                />
              </div>

              <div className="mt-4">
                <label htmlFor="invite-phone" className={labelClass}>
                  {t("common.phone")}
                </label>
                <PhoneInput id="invite-phone" required onChange={(composed) => setPhone(composed)} />
              </div>

              <div className="mt-4">
                <label htmlFor="invite-password" className={labelClass}>
                  {t("common.password")}
                </label>
                <input
                  id="invite-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                />
                <ul className="mt-2 space-y-1">
                  {PASSWORD_RULES.map((r) => (
                    <RuleCheck key={r.key} done={r.test(password)} label={t(r.labelKey, r.labelParams)} />
                  ))}
                </ul>
              </div>

              <div className="mt-4">
                <label htmlFor="invite-confirm-password" className={labelClass}>
                  {t("invite.form.confirmPasswordLabel")}
                </label>
                <input
                  id="invite-confirm-password"
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputClass}
                />
                {!passwordsMatch && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t("common.passwordsMismatch")}</p>
                )}
              </div>

              {formError && <p className="mt-4 text-center text-sm text-red-600 dark:text-red-400">{formError}</p>}

              <button type="submit" disabled={submitting} className={buttonClass}>
                {submitting ? t("invite.form.submitting") : t("invite.form.submit")}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
