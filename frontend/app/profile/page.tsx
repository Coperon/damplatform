"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { useTranslation, interpolateJSX } from "@/lib/i18n";

interface Profile {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  tenantId: string | null;
  roleId: number;
  roleName: string;
  tenant: { id: string; name: string; address: string | null; phone: string | null } | null;
  pendingEmailChange: { newEmail: string; expiresAt: string } | null;
}

// Mirrors lib/users.ts's validatePasswordStrength exactly (length 8+,
// upper/lower/digit/special) and app/invite/[token]/page.tsx's own
// restatement of the same rules — that function isn't reachable from a
// client component, so every client-side form that collects a new password
// duplicates this list and must be kept in sync with it by hand if the
// server rule ever changes. Labels are translation keys (+ optional
// interpolation params), resolved at render time via t() inside the
// component — see app/invite/[token]/page.tsx's identical restructuring.
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const inputClass =
  "rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15";
const labelClass = "text-xs font-medium text-slate";
const saveButtonClass =
  "cursor-pointer rounded-[8px] bg-brand px-4 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass =
  "cursor-pointer rounded-[8px] border border-line bg-white/60 dark:bg-white/10 px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-mist disabled:cursor-not-allowed disabled:opacity-60";
const panelClass = "dam-glass flex flex-col gap-4 rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]";

export default function ProfilePage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Name
  const [nameInput, setNameInput] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  // Password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  // Email
  const [newEmailInput, setNewEmailInput] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Company (tenant) details — only rendered for a company admin (roleId 2);
  // see the caption near that section for why the acting-company switcher
  // never changes which company this edits.
  const [tenantName, setTenantName] = useState("");
  const [tenantAddress, setTenantAddress] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [tenantSaving, setTenantSaving] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [tenantSaved, setTenantSaved] = useState(false);

  function loadProfile() {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    setLoading(true);
    setLoadError(null);
    fetch("/api/profile", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        if (!res.ok) throw new Error(t("common.error.generic", { status: res.status }));
        return res.json() as Promise<Profile>;
      })
      .then((data) => {
        setProfile(data);
        setNameInput(data.name ?? "");
        if (data.tenant) {
          setTenantName(data.tenant.name);
          setTenantAddress(data.tenant.address ?? "");
          setTenantPhone(data.tenant.phone ?? "");
        }
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : t("profile.error.loadFailed"));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    setAuthorized(true);
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    if (!token || !profile) return;

    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNameError(t("metadataFields.add.nameRequired"));
      return;
    }

    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNameError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      const updated = body as { name: string | null };
      setProfile((prev) => (prev ? { ...prev, name: updated.name } : prev));
      setNameInput(updated.name ?? "");
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch {
      setNameError(t("common.error.couldNotReachServer"));
    } finally {
      setNameSaving(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    if (!token) return;

    setPasswordError(null);
    setPasswordSuccess(null);

    if (!currentPassword) {
      setPasswordError(t("profile.password.error.currentRequired"));
      return;
    }
    if (!passwordMeetsAllRules(newPassword)) {
      setPasswordError(t("profile.password.error.requirements"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t("profile.password.error.newMismatch"));
      return;
    }

    setPasswordSaving(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPasswordError((body as { message?: string }).message ?? t("common.error.generic", { status: res.status }));
        return;
      }
      // Sessions are stateless JWTs with no revocation list — changing the
      // password does not sign out any other device already logged in with
      // the old one. Stated plainly rather than left implicit.
      setPasswordSuccess(t("profile.password.success"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPasswordError(t("common.error.couldNotReachServer"));
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleRequestEmailChange(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    if (!token) return;

    setEmailError(null);
    setEmailSuccess(null);

    const trimmed = newEmailInput.trim();
    if (!trimmed) {
      setEmailError(t("profile.email.error.required"));
      return;
    }

    setEmailSaving(true);
    try {
      const res = await fetch("/api/profile/email-change", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newEmail: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEmailError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      const result = body as { newEmail: string; expiresAt: string };
      setProfile((prev) =>
        prev ? { ...prev, pendingEmailChange: { newEmail: result.newEmail, expiresAt: result.expiresAt } } : prev,
      );
      setNewEmailInput("");
      setEmailSuccess(t("profile.email.successSent", { email: result.newEmail }));
    } catch {
      setEmailError(t("common.error.couldNotReachServer"));
    } finally {
      setEmailSaving(false);
    }
  }

  async function handleCancelEmailChange() {
    const token = localStorage.getItem("token");
    if (!token) return;
    setCancelling(true);
    setEmailError(null);
    setEmailSuccess(null);
    try {
      const res = await fetch("/api/profile/email-change", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setEmailError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      setProfile((prev) => (prev ? { ...prev, pendingEmailChange: null } : prev));
    } catch {
      setEmailError(t("common.error.couldNotReachServer"));
    } finally {
      setCancelling(false);
    }
  }

  async function handleSaveTenant(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    if (!token || !profile?.tenant) return;

    const name = tenantName.trim();
    const address = tenantAddress.trim();
    const phone = tenantPhone.trim();
    if (!name || !address || !phone) {
      setTenantError(t("profile.tenant.error.required"));
      return;
    }

    setTenantSaving(true);
    setTenantError(null);
    setTenantSaved(false);
    try {
      const res = await fetch("/api/profile/tenant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, address, phone }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTenantError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      const updated = body as { id: string; name: string; address: string | null; phone: string | null };
      setProfile((prev) => (prev ? { ...prev, tenant: updated } : prev));
      setTenantName(updated.name);
      setTenantAddress(updated.address ?? "");
      setTenantPhone(updated.phone ?? "");
      setTenantSaved(true);
      setTimeout(() => setTenantSaved(false), 2000);
    } catch {
      setTenantError(t("common.error.couldNotReachServer"));
    } finally {
      setTenantSaving(false);
    }
  }

  if (!authorized) return null;

  const nameDirty = profile !== null && nameInput.trim() !== (profile.name ?? "");
  const tenantDirty =
    profile?.tenant !== null &&
    profile?.tenant !== undefined &&
    (tenantName.trim() !== profile.tenant.name ||
      tenantAddress.trim() !== (profile.tenant.address ?? "") ||
      tenantPhone.trim() !== (profile.tenant.phone ?? ""));

  return (
    <AppShell active="profile" title={t("account.profile")}>
      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && profile && (
        <div className="flex max-w-2xl flex-col gap-6">
          {/* Name */}
          <form onSubmit={handleSaveName} className={panelClass}>
            <div>
              <p className="text-sm font-semibold text-ink">{t("common.name")}</p>
              <p className="mt-1 text-xs text-slate">{t("profile.name.hint")}</p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                <label htmlFor="profile-name" className={labelClass}>
                  {t("common.name")}
                </label>
                <input
                  id="profile-name"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  maxLength={100}
                  className={inputClass}
                />
              </div>
              <button type="submit" disabled={nameSaving || !nameDirty} className={saveButtonClass}>
                {nameSaving ? t("common.saving") : t("common.save")}
              </button>
            </div>
            {nameError && <p className="text-xs text-red-600 dark:text-red-400">{nameError}</p>}
            {nameSaved && <p className="text-xs text-green-600 dark:text-green-400">{t("profile.saved")}</p>}
          </form>

          {/* Password */}
          <form onSubmit={handleChangePassword} className={panelClass}>
            <div>
              <p className="text-sm font-semibold text-ink">{t("common.password")}</p>
              <p className="mt-1 text-xs text-slate">{t("profile.password.hint")}</p>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="profile-current-password" className={labelClass}>
                {t("profile.password.currentLabel")}
              </label>
              <input
                id="profile-current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={`${inputClass} max-w-xs`}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="profile-new-password" className={labelClass}>
                {t("profile.password.newLabel")}
              </label>
              <input
                id="profile-new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={`${inputClass} max-w-xs`}
              />
              <ul className="mt-1 space-y-1">
                {PASSWORD_RULES.map((r) => (
                  <RuleCheck key={r.key} done={r.test(newPassword)} label={t(r.labelKey, r.labelParams)} />
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="profile-confirm-password" className={labelClass}>
                {t("profile.password.confirmLabel")}
              </label>
              <input
                id="profile-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`${inputClass} max-w-xs`}
              />
              {confirmPassword.length > 0 && confirmPassword !== newPassword && (
                <p className="text-xs text-red-600 dark:text-red-400">{t("common.passwordsMismatch")}</p>
              )}
            </div>

            <div>
              <button
                type="submit"
                disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
                className={saveButtonClass}
              >
                {passwordSaving ? t("profile.password.submitting") : t("profile.password.submit")}
              </button>
            </div>
            {passwordError && <p className="text-xs text-red-600 dark:text-red-400">{passwordError}</p>}
            {passwordSuccess && <p className="text-xs text-green-600 dark:text-green-400">{passwordSuccess}</p>}
          </form>

          {/* Email */}
          <div className={panelClass}>
            <div>
              <p className="text-sm font-semibold text-ink">{t("common.email")}</p>
              <p className="mt-1 text-xs text-slate">
                {interpolateJSX(t("profile.email.hint"), {
                  email: <span className="font-medium text-ink">{profile.email}</span>,
                })}
              </p>
            </div>

            {profile.pendingEmailChange ? (
              <div className="flex flex-col gap-3 rounded-[10px] border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 p-4">
                <p className="text-sm text-amber-900 dark:text-amber-200">
                  {interpolateJSX(t("profile.email.pendingNotice", { date: formatDateTime(profile.pendingEmailChange.expiresAt) }), {
                    email: <span className="font-semibold">{profile.pendingEmailChange.newEmail}</span>,
                  })}
                </p>
                <div>
                  <button
                    type="button"
                    onClick={handleCancelEmailChange}
                    disabled={cancelling}
                    className={secondaryButtonClass}
                  >
                    {cancelling ? t("profile.email.cancelling") : t("profile.email.cancelSubmit")}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleRequestEmailChange} className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-[240px] flex-1 flex-col gap-1">
                  <label htmlFor="profile-new-email" className={labelClass}>
                    {t("profile.email.newLabel")}
                  </label>
                  <input
                    id="profile-new-email"
                    type="email"
                    value={newEmailInput}
                    onChange={(e) => setNewEmailInput(e.target.value)}
                    placeholder="new-address@example.com"
                    maxLength={255}
                    className={inputClass}
                  />
                </div>
                <button type="submit" disabled={emailSaving || !newEmailInput.trim()} className={saveButtonClass}>
                  {emailSaving ? t("profile.email.sending") : t("profile.email.sendLink")}
                </button>
              </form>
            )}
            {emailError && <p className="text-xs text-red-600 dark:text-red-400">{emailError}</p>}
            {emailSuccess && <p className="text-xs text-green-600 dark:text-green-400">{emailSuccess}</p>}
          </div>

          {/* Company details — company admins only (roleId 2). True super
              admins have no company at all, so this section is omitted for
              them entirely rather than letting them pick one to edit —
              editing an arbitrary company already has a dedicated,
              super-admin-only surface (/admin/tenants). */}
          {profile.tenant && (
            <form onSubmit={handleSaveTenant} className={panelClass}>
              <div>
                <p className="text-sm font-semibold text-ink">{t("profile.tenant.heading")}</p>
                <p className="mt-1 text-xs text-slate">
                  {t("profile.tenant.hint")}
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-[200px] flex-1 flex-col gap-1">
                  <label htmlFor="tenant-name" className={labelClass}>
                    {t("common.name")}
                  </label>
                  <input
                    id="tenant-name"
                    value={tenantName}
                    onChange={(e) => setTenantName(e.target.value)}
                    maxLength={200}
                    className={inputClass}
                  />
                </div>
                <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                  <label htmlFor="tenant-address" className={labelClass}>
                    {t("tenants.form.addressLabel")}
                  </label>
                  <input
                    id="tenant-address"
                    value={tenantAddress}
                    onChange={(e) => setTenantAddress(e.target.value)}
                    maxLength={255}
                    className={inputClass}
                  />
                </div>
                <div className="flex min-w-[180px] flex-1 flex-col gap-1">
                  <label htmlFor="tenant-phone" className={labelClass}>
                    {t("common.phone")}
                  </label>
                  <input
                    id="tenant-phone"
                    value={tenantPhone}
                    onChange={(e) => setTenantPhone(e.target.value)}
                    maxLength={30}
                    placeholder="+961 71234567"
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <button type="submit" disabled={tenantSaving || !tenantDirty} className={saveButtonClass}>
                  {tenantSaving ? t("common.saving") : t("profile.tenant.submit")}
                </button>
              </div>
              {tenantError && <p className="text-xs text-red-600 dark:text-red-400">{tenantError}</p>}
              {tenantSaved && <p className="text-xs text-green-600 dark:text-green-400">{t("profile.saved")}</p>}
            </form>
          )}
        </div>
      )}
    </AppShell>
  );
}
