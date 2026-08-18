"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import Select from "@/components/Select";
import PhoneInput from "@/components/PhoneInput";
import { useTranslation } from "@/lib/i18n";

interface Tenant {
  id: string;
  name: string;
  userCount: number;
  hasAdmin: boolean;
}

interface DeletePreview {
  collectionsToDelete: number;
  collectionsSkippedShared: number;
  resourcesToDelete: number;
}

type InviteRoleId = 2 | 3 | 4;

interface Invitation {
  id: string;
  email: string;
  role: { id: number; name: string };
  tenant: { id: string; name: string };
  invitedBy: { id: string; email: string; name: string | null } | null;
  expiresAt: string;
  createdAt: string;
  status: "pending" | "expired";
}

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
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


function invitationStatusClass(status: Invitation["status"]): string {
  return status === "pending"
    ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
    : "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300";
}

export default function AdminTenantsPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notSuperAdmin, setNotSuperAdmin] = useState(false);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Create tenant — the super admin enters ALL tenant details here (name,
  // address, phone, all required); nothing is left for invite redemption to
  // fill in. phoneResetKey remounts the self-contained PhoneInput to clear
  // it after a successful create.
  const [newTenantName, setNewTenantName] = useState("");
  const [newTenantAddress, setNewTenantAddress] = useState("");
  const [newTenantPhone, setNewTenantPhone] = useState("");
  const [phoneResetKey, setPhoneResetKey] = useState(0);
  const [creatingTenant, setCreatingTenant] = useState(false);
  const [createTenantError, setCreateTenantError] = useState<string | null>(null);

  // Create invite — a super admin picks both the tenant and the role;
  // a tenant's own "Invite admin" button below just pre-fills these two
  // fields rather than opening a separate flow.
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteTenantId, setInviteTenantId] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState<InviteRoleId>(3);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const inviteFormRef = useRef<HTMLFormElement>(null);
  const inviteEmailRef = useRef<HTMLInputElement>(null);

  const [revokingIds, setRevokingIds] = useState<Set<string>>(new Set());
  const [revokeErrors, setRevokeErrors] = useState<Record<string, string>>({});

  // Delete company — the modal opens on a preview fetch (the exact same
  // exclusivity computation the real DELETE runs, see app/api/tenants/[id]/
  // route.ts's shared helpers), never a guess at what will happen. The
  // confirm button stays disabled until confirmNameInput matches the
  // tenant's name exactly (case-sensitive, trimmed) — the server enforces
  // the same check independently, this is purely a UX gate.
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmNameInput, setConfirmNameInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function loadData() {
    const token = localStorage.getItem("token");
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetch("/api/tenants?detail=true", { headers }).then((r) => {
        if (!r.ok) throw new Error(t("tenants.error.loadCompaniesHttp", { status: r.status }));
        return r.json() as Promise<{ tenants: Tenant[] }>;
      }),
      fetch("/api/invitations", { headers }).then((r) => {
        if (!r.ok) throw new Error(t("common.error.loadInvitationsHttp", { status: r.status }));
        return r.json() as Promise<{ invitations: Invitation[] }>;
      }),
    ])
      .then(([tenantsData, invitationsData]) => {
        setTenants(tenantsData.tenants);
        setInvitations(invitationsData.invitations);
        setInviteTenantId((prev) => prev || tenantsData.tenants[0]?.id || "");
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : t("common.error.loadFailed"));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    const payload = parseToken(token);
    // Tenant management is structure/cross-tenant (any super admin can see
    // and create any tenant) — same tier classification as Media/Metadata/
    // Shares (Stage 6), not the tenant-scoped Users page.
    if (payload?.roleName !== "super_admin") {
      setNotSuperAdmin(true);
      setAuthorized(true);
      return;
    }
    setAuthorized(true);
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function handleCreateTenant(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    if (!token) return;
    const name = newTenantName.trim();
    const address = newTenantAddress.trim();
    // newTenantPhone is already the composed "+<dial> <number>" string
    // PhoneInput emits, or "" if no digits were typed.
    if (!name || !address || !newTenantPhone) {
      setCreateTenantError(t("tenants.form.fillRequired"));
      return;
    }

    setCreatingTenant(true);
    setCreateTenantError(null);
    try {
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, address, phone: newTenantPhone }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateTenantError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      const created = body as { id: string; name: string };
      setTenants((prev) =>
        [...prev, { id: created.id, name: created.name, userCount: 0, hasAdmin: false }].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setNewTenantName("");
      setNewTenantAddress("");
      setNewTenantPhone("");
      setPhoneResetKey((k) => k + 1);
    } catch {
      setCreateTenantError(t("common.error.couldNotReachServer"));
    } finally {
      setCreatingTenant(false);
    }
  }

  function handleInviteAdminFor(tenantId: string) {
    setInviteTenantId(tenantId);
    setInviteRoleId(2);
    setInviteError(null);
    setInviteSuccess(null);
    inviteFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    inviteEmailRef.current?.focus();
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    if (!token) return;

    const email = inviteEmail.trim();
    if (!email) {
      setInviteError(t("common.invite.enterEmail"));
      return;
    }
    if (!inviteTenantId) {
      setInviteError(t("tenants.invite.chooseCompany"));
      return;
    }

    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, roleId: inviteRoleId, tenantId: inviteTenantId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      const created = body as Invitation;
      setInvitations((prev) => [{ ...created, createdAt: new Date().toISOString(), status: "pending" }, ...prev]);
      setInviteSuccess(t("common.invite.success", { email: created.email }));
      setInviteEmail("");
    } catch {
      setInviteError(t("common.error.couldNotReachServer"));
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke(invitation: Invitation) {
    const token = localStorage.getItem("token");
    if (!token) return;
    setRevokingIds((prev) => new Set(prev).add(invitation.id));
    setRevokeErrors((prev) => { const n = { ...prev }; delete n[invitation.id]; return n; });
    try {
      const res = await fetch(`/api/invitations/${invitation.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRevokeErrors((prev) => ({ ...prev, [invitation.id]: (body as { error?: string }).error ?? t("common.error.generic", { status: res.status }) }));
        return;
      }
      setInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
    } catch {
      setRevokeErrors((prev) => ({ ...prev, [invitation.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setRevokingIds((prev) => { const n = new Set(prev); n.delete(invitation.id); return n; });
    }
  }

  function openDeleteModal(tenant: Tenant) {
    setDeleteTarget(tenant);
    setDeletePreview(null);
    setPreviewError(null);
    setConfirmNameInput("");
    setDeleteError(null);
    setPreviewLoading(true);
    const token = localStorage.getItem("token");
    if (!token) return;
    fetch(`/api/tenants/${tenant.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((body as { error?: string }).error ?? t("common.error.generic", { status: r.status }));
        setDeletePreview(body as DeletePreview);
      })
      .catch((err: unknown) => {
        setPreviewError(err instanceof Error ? err.message : t("tenants.error.loadPreviewGeneric"));
      })
      .finally(() => setPreviewLoading(false));
  }

  function closeDeleteModal() {
    if (deleting) return;
    setDeleteTarget(null);
    setDeletePreview(null);
    setConfirmNameInput("");
    setDeleteError(null);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const token = localStorage.getItem("token");
    if (!token) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/tenants/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ confirmName: confirmNameInput }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      setTenants((prev) => prev.filter((tn) => tn.id !== deleteTarget.id));
      setInvitations((prev) => prev.filter((inv) => inv.tenant.id !== deleteTarget.id));
      setDeleteTarget(null);
      setDeletePreview(null);
      setConfirmNameInput("");
    } catch {
      setDeleteError(t("common.error.couldNotReachServer"));
    } finally {
      setDeleting(false);
    }
  }

  if (!authorized) return null;

  if (notSuperAdmin) {
    return (
      <AppShell active="tenants" title={t("nav.companies")}>
        <div className="flex items-center justify-center py-24">
          <div className="text-center">
            <p className="text-lg font-semibold text-ink">{t("common.notAuthorized")}</p>
            <Link href="/home" className="mt-3 inline-block text-sm text-brand hover:underline">
              {t("common.backToHome")}
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  const countPill = !loading && !loadError ? (
    <span className="dam-glass inline-flex h-9 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium text-ink">
      {t("tenants.count", { count: tenants.length })}
    </span>
  ) : undefined;

  return (
    <AppShell active="tenants" title={t("nav.companies")} actions={countPill}>
      {/* Create company — the super admin enters all company details here
          (name, address, phone, all required). Invite redemption no longer
          collects any company info. */}
      <form
        onSubmit={handleCreateTenant}
        className="dam-glass mb-6 flex flex-col gap-3 rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]"
      >
        <p className="text-sm font-semibold text-ink">{t("tenants.form.newCompanyHeading")}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1">
            <label htmlFor="new-company-name" className="text-xs font-medium text-slate">
              {t("common.name")}
            </label>
            <input
              id="new-company-name"
              required
              value={newTenantName}
              onChange={(e) => setNewTenantName(e.target.value)}
              placeholder={t("tenants.form.namePlaceholder")}
              maxLength={200}
              className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>
          <div className="flex min-w-[220px] flex-1 flex-col gap-1">
            <label htmlFor="new-company-address" className="text-xs font-medium text-slate">
              {t("tenants.form.addressLabel")}
            </label>
            <input
              id="new-company-address"
              required
              value={newTenantAddress}
              onChange={(e) => setNewTenantAddress(e.target.value)}
              placeholder={t("tenants.form.addressPlaceholder")}
              maxLength={255}
              className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>
          <div className="flex min-w-[260px] flex-1 flex-col gap-1">
            <label htmlFor="new-company-phone" className="text-xs font-medium text-slate">
              {t("tenants.form.phoneLabel")}
            </label>
            <PhoneInput
              key={phoneResetKey}
              id="new-company-phone"
              required
              onChange={(composed) => setNewTenantPhone(composed)}
            />
          </div>
          <button
            type="submit"
            disabled={creatingTenant}
            className="cursor-pointer rounded-[8px] bg-brand px-4 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creatingTenant ? t("tenants.form.creating") : t("tenants.form.submit")}
          </button>
        </div>
        {createTenantError && (
          <p className="w-full text-xs text-red-600 dark:text-red-400">{createTenantError}</p>
        )}
      </form>

      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && (
        <>
          {/* Companies list */}
          <div className="dam-glass mb-8 overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-line/70">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.company")}</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("nav.users")}</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.role.admin")}</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {tenants.map((c) => (
                  <tr key={c.id} className="border-b border-surface-tint-2 last:border-b-0 transition-colors hover:bg-white/40 dark:hover:bg-white/5">
                    <td className="px-5 py-3 text-sm font-medium text-ink">{c.name}</td>
                    <td className="px-5 py-3 text-sm text-ink">{c.userCount}</td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                          c.hasAdmin
                            ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                            : "border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                        }`}
                      >
                        {c.hasAdmin ? t("tenants.table.hasAdmin") : t("tenants.table.noAdminYet")}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleInviteAdminFor(c.id)}
                          className="cursor-pointer rounded-[8px] border border-line bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-mist"
                        >
                          {t("tenants.table.inviteAdmin")}
                        </button>
                        <button
                          onClick={() => openDeleteModal(c)}
                          className="cursor-pointer rounded-[8px] border border-red-200 dark:border-red-800/60 bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40"
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tenants.length === 0 && (
              <p className="px-5 py-6 text-sm text-slate">{t("tenants.table.empty")}</p>
            )}
          </div>

          {/* Create invite — a super admin may target any tenant with any
              of the three invitable roles. The backend (POST /api/invitations)
              is the real authority on all of this; these options are simply
              what a super admin is actually allowed to do, so nothing here
              is UI-only enforcement. */}
          <form
            ref={inviteFormRef}
            onSubmit={handleInvite}
            className="dam-glass mb-6 flex flex-col gap-4 rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]"
          >
            <p className="text-sm font-semibold text-ink">{t("tenants.invite.heading")}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                <label htmlFor="invite-email" className="text-xs font-medium text-slate">
                  {t("common.email")}
                </label>
                <input
                  id="invite-email"
                  ref={inviteEmailRef}
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="invite-company" className="text-xs font-medium text-slate">
                  {t("common.company")}
                </label>
                <Select
                  id="invite-company"
                  value={inviteTenantId}
                  onChange={setInviteTenantId}
                  options={
                    tenants.length === 0
                      ? [{ value: "", label: t("tenants.invite.noCompaniesYet") }]
                      : tenants.map((c) => ({ value: c.id, label: c.name }))
                  }
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="invite-role" className="text-xs font-medium text-slate">
                  {t("common.role")}
                </label>
                <Select
                  id="invite-role"
                  value={String(inviteRoleId)}
                  onChange={(v) => setInviteRoleId(Number(v) as InviteRoleId)}
                  options={[
                    { value: "2", label: t("common.role.admin") },
                    { value: "3", label: t("common.role.editor") },
                    { value: "4", label: t("common.role.viewer") },
                  ]}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                />
              </div>

              <button
                type="submit"
                disabled={inviting || tenants.length === 0}
                className="cursor-pointer rounded-[8px] bg-brand px-4 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {inviting ? t("common.invite.sending") : t("common.invite.submit")}
              </button>
            </div>
            {inviteError && <p className="text-xs text-red-600 dark:text-red-400">{inviteError}</p>}
            {inviteSuccess && <p className="text-xs text-emerald-700 dark:text-emerald-300">{inviteSuccess}</p>}
          </form>

          {/* Pending invites — every tenant (super admin sees all). */}
          <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-line/70">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.email")}</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.role")}</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.company")}</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.status")}</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.expires")}</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const revoking = revokingIds.has(inv.id);
                  const error = revokeErrors[inv.id];
                  return (
                    <tr key={inv.id} className="border-b border-surface-tint-2 last:border-b-0 transition-colors hover:bg-white/40 dark:hover:bg-white/5">
                      <td className="px-5 py-3 text-sm text-ink">{inv.email}</td>
                      <td className="px-5 py-3 text-sm capitalize text-ink">{inv.role.name}</td>
                      <td className="px-5 py-3 text-sm text-ink">{inv.tenant.name}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${invitationStatusClass(inv.status)}`}>
                          {inv.status === "pending" ? t("common.pending") : t("common.expired")}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-sm text-ink">{formatDateTime(inv.expiresAt)}</td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-2.5">
                          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
                          <button
                            onClick={() => handleRevoke(inv)}
                            disabled={revoking}
                            className="cursor-pointer rounded-[8px] border border-red-200 dark:border-red-800/60 bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {revoking ? t("common.invite.revoking") : t("common.invite.revoke")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {invitations.length === 0 && (
              <p className="px-5 py-6 text-sm text-slate">{t("common.invite.empty")}</p>
            )}
          </div>
        </>
      )}

      {/* Delete company modal — same top-level fixed-overlay convention as
          the collection page's share/access modals. Cancel (closing via the
          backdrop, Escape, or the Cancel button) is the only action available
          until the typed name matches exactly; nothing is destructive until
          that point. */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
          onClick={closeDeleteModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="dam-glass w-full max-w-md rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-red-600 dark:text-red-400">{t("tenants.delete.heading")}</p>
            <p className="mt-2 text-sm text-ink">
              {t("tenants.delete.warning", { name: deleteTarget.name })}
            </p>

            {previewLoading && <p className="mt-4 text-xs text-slate">{t("tenants.delete.calculating")}</p>}
            {previewError && <p className="mt-4 text-xs text-red-600 dark:text-red-400">{previewError}</p>}
            {deletePreview && (
              <ul className="mt-4 space-y-1 rounded-[10px] border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-950/30 px-3.5 py-3 text-xs text-ink">
                <li>{t("tenants.delete.usersWillBeDeleted", { count: deleteTarget.userCount })}</li>
                <li>{t("tenants.delete.collectionsWillBeDeleted", { count: deletePreview.collectionsToDelete })}</li>
                <li>{t("tenants.delete.filesWillBeDeleted", { count: deletePreview.resourcesToDelete })}</li>
                {deletePreview.collectionsSkippedShared > 0 && (
                  <li className="text-slate">
                    {t("tenants.delete.collectionsSkippedShared", { count: deletePreview.collectionsSkippedShared })}
                  </li>
                )}
              </ul>
            )}

            <div className="mt-4">
              <label htmlFor="delete-confirm-name" className="text-xs font-medium text-slate">
                {t("tenants.delete.typeToConfirm", { name: deleteTarget.name })}
              </label>
              <input
                id="delete-confirm-name"
                autoFocus
                autoComplete="off"
                value={confirmNameInput}
                onChange={(e) => setConfirmNameInput(e.target.value)}
                className="mt-1.5 w-full rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
              />
            </div>

            {deleteError && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{deleteError}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={closeDeleteModal}
                disabled={deleting}
                className="cursor-pointer rounded-[8px] border border-line bg-white/60 dark:bg-white/10 px-3 py-1.5 text-sm font-medium text-ink hover:bg-mist disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleting || confirmNameInput !== deleteTarget.name || !deletePreview}
                className="cursor-pointer rounded-[8px] bg-red-600 px-3 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_rgba(220,38,38,0.25)] transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? t("common.deleting") : t("common.deletePermanently")}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
