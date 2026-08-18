"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import Select from "@/components/Select";
import { useTranslation } from "@/lib/i18n";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

interface User {
  id: string;
  email: string;
  name: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  role_id: number;
  role_name: string;
  can_access_all_tenants: boolean;
  can_invite: boolean;
  created_at: string;
}

interface Tenant {
  id: string;
  name: string;
}

// A tenant admin's own invite control/list, rendered further down this
// page — only editor(3)/viewer(4) are offered, mirroring POST
// /api/invitations' TENANT_ADMIN_INVITABLE_ROLES; the backend remains the
// real authority regardless of what this UI offers.
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

// Static — the 5 seed roles never change at runtime, so there's no API for
// this (unlike Tenant, which is fetched). Capability derives from role_id —
// this is what the Role column edits.
const ROLES: { id: number; name: string }[] = [
  { id: 1, name: "super_admin" },
  { id: 2, name: "admin" },
  { id: 3, name: "editor" },
  { id: 4, name: "viewer" },
  { id: 5, name: "pending" },
];

// What a tenant admin (not a super admin) may set another user's role to —
// mirrors PATCH /api/users/[id]'s own TENANT_ADMIN_ASSIGNABLE_ROLES server
// side; kept in sync deliberately since this only narrows the dropdown's
// options, never widens what the server will actually accept.
const TENANT_ADMIN_ASSIGNABLE_ROLE_IDS = new Set([3, 4]);

// Sentinel for the "None" option in the Company <select> — tenant ids are
// uuids, so this string can never collide with a real one. Mapped to/from
// `null` (no tenant) at the change handler, never stored as-is.
const NONE_TENANT = "__none__";

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Same derivation as the AppShell account menu — keeps avatar initials consistent app-wide.
// Accepts a name ("Georges Koueik") or an email ("georges.k@..."); splits on whitespace too
// so a real display name still yields two-letter initials, not just the email local-part.
function getInitials(value: string | null): string | null {
  if (!value) return null;
  const local = value.includes("@") ? value.split("@")[0] : value;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  if (local.length === 1) return local.toUpperCase();
  return null;
}

async function fetchUsers(token: string, roleId: string, tenantId: string, t: TFunc): Promise<User[]> {
  const params = new URLSearchParams();
  if (roleId) params.set("roleId", roleId);
  if (tenantId) params.set("tenantId", tenantId);
  const qs = params.toString();
  const res = await fetch(`/api/users${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(t("users.error.loadUsersHttp", { status: res.status }));
  return res.json() as Promise<User[]>;
}

function LockIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" strokeLinejoin="round" />
      <path d="M6.5 9V6.5a3.5 3.5 0 017 0V9" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 6h12M8 6V4.5a1 1 0 011-1h2a1 1 0 011 1V6M6 6l.6 9.4a1.5 1.5 0 001.5 1.4h3.8a1.5 1.5 0 001.5-1.4L14 6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 9v4.5M11.5 9v4.5" strokeLinecap="round" />
    </svg>
  );
}

function Spinner() {
  return <span className="block h-4 w-4 animate-spin rounded-full border-2 border-red-400 border-t-transparent" />;
}

export default function AdminUsersPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  const [selfId, setSelfId] = useState("");
  // Caller's own tier — a tenant admin (canAdmin: true, roleName "admin")
  // sees only their own tenant's users (server-enforced) and may edit
  // neither Company nor the super_admin/admin roles (also server-enforced);
  // this only narrows what's shown/editable to match, never the authority.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  // Invite authority is a per-user grant (users.can_invite) — a super admin
  // always has it; any other admin only when a super admin has granted the
  // flag. Drives whether the invite section below is rendered at all: POST
  // /api/invitations 403s without it, so showing the form to an admin
  // lacking the flag would be the exact UI/server mismatch this app keeps
  // closing. Read straight from this caller's own token, never re-derived.
  const [canInviteSelf, setCanInviteSelf] = useState(false);

  const [users, setUsers] = useState<User[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState("");
  // Super-admin only — a tenant admin has nothing to narrow (their list is
  // already pinned to one tenant server-side), so this control is only
  // rendered, and only ever set to a non-empty value, when isSuperAdmin.
  const [tenantFilter, setTenantFilter] = useState("");

  // Per-row pending tenant/role selection / name edit (not yet saved)
  const [pendingTenants, setPendingTenants] = useState<Record<string, string | null>>({});
  const [pendingRoles, setPendingRoles] = useState<Record<string, number>>({});
  const [pendingNames, setPendingNames] = useState<Record<string, string>>({});
  const [pendingAllTenants, setPendingAllTenants] = useState<Record<string, boolean>>({});
  const [pendingInvite, setPendingInvite] = useState<Record<string, boolean>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  // Tenant admin's own invite control + pending-invites list (Stage 92) —
  // a super admin manages invites on /admin/tenants instead, so none of
  // this is fetched/rendered for them, avoiding a second, duplicate surface.
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(false);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState<3 | 4>(3);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [revokingInviteIds, setRevokingInviteIds] = useState<Set<string>>(new Set());
  const [revokeInviteErrors, setRevokeInviteErrors] = useState<Record<string, string>>({});

  const skipNextFilterFetch = useRef(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    const payload = parseToken(token);
    if (!payload?.canAdmin) {
      setNotAdmin(true);
      setAuthorized(true);
      return;
    }
    const superAdmin = payload?.roleName === "super_admin";
    setIsSuperAdmin(superAdmin);
    setCanInviteSelf(payload?.canInvite === true);
    setSelfId(String(payload.sub));
    setAuthorized(true);

    const headers = { Authorization: `Bearer ${token}` };

    // GET /api/tenants is super-admin-only (Stage 6) — a tenant admin
    // can't set/change anyone's tenant anyway, so the Company column just
    // shows read-only text for them and this fetch is skipped entirely.
    Promise.all([
      fetchUsers(token, "", "", t),
      superAdmin
        ? fetch("/api/tenants", { headers }).then((r) => {
            if (!r.ok) throw new Error(t("users.error.loadTenantsHttp", { status: r.status }));
            return r.json() as Promise<Tenant[]>;
          })
        : Promise.resolve<Tenant[]>([]),
    ])
      .then(([usersData, tenantsData]) => {
        setUsers(usersData);
        setTenants(tenantsData);
        const initialTenants: Record<string, string | null> = {};
        const initialRoles: Record<string, number> = {};
        const initialNames: Record<string, string> = {};
        const initialAllTenants: Record<string, boolean> = {};
        const initialInvite: Record<string, boolean> = {};
        for (const u of usersData) {
          initialTenants[u.id] = u.tenant_id;
          initialRoles[u.id] = u.role_id;
          initialNames[u.id] = u.name ?? "";
          initialAllTenants[u.id] = u.can_access_all_tenants;
          initialInvite[u.id] = u.can_invite;
        }
        setPendingTenants(initialTenants);
        setPendingRoles(initialRoles);
        setPendingNames(initialNames);
        setPendingAllTenants(initialAllTenants);
        setPendingInvite(initialInvite);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : t("common.error.loadFailed"));
      })
      .finally(() => setLoading(false));
  }, [router]);

  // Tenant admin's own pending invites — fetched separately from the main
  // load above since it's conditional on tier (a super admin never runs
  // this; see the invite-section comment on the state above).
  useEffect(() => {
    // Admins lacking the flag skip this too — their invite section is
    // hidden (they can't invite), so fetching its data would be wasted work.
    if (!authorized || notAdmin || isSuperAdmin || !canInviteSelf) return;
    const token = localStorage.getItem("token");
    if (!token) return;
    setInvitationsLoading(true);
    setInvitationsError(null);
    fetch("/api/invitations", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error(t("common.error.loadInvitationsHttp", { status: r.status }));
        return r.json() as Promise<{ invitations: Invitation[] }>;
      })
      .then((data) => setInvitations(data.invitations))
      .catch((err: unknown) => {
        setInvitationsError(err instanceof Error ? err.message : t("users.error.loadInvitationsFailed"));
      })
      .finally(() => setInvitationsLoading(false));
  }, [authorized, notAdmin, isSuperAdmin, canInviteSelf]);

  // Refetch when the role or tenant filter changes — skips the run that
  // fires on mount (the initial load above already fetched the unfiltered list).
  useEffect(() => {
    if (skipNextFilterFetch.current) {
      skipNextFilterFetch.current = false;
      return;
    }
    if (!authorized || notAdmin) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    setLoading(true);
    setLoadError(null);
    fetchUsers(token, roleFilter, tenantFilter, t)
      .then((usersData) => {
        setUsers(usersData);
        setPendingTenants((prev) => {
          const next = { ...prev };
          for (const u of usersData) if (!(u.id in next)) next[u.id] = u.tenant_id;
          return next;
        });
        setPendingRoles((prev) => {
          const next = { ...prev };
          for (const u of usersData) if (!(u.id in next)) next[u.id] = u.role_id;
          return next;
        });
        setPendingNames((prev) => {
          const next = { ...prev };
          for (const u of usersData) if (!(u.id in next)) next[u.id] = u.name ?? "";
          return next;
        });
        setPendingAllTenants((prev) => {
          const next = { ...prev };
          for (const u of usersData) if (!(u.id in next)) next[u.id] = u.can_access_all_tenants;
          return next;
        });
        setPendingInvite((prev) => {
          const next = { ...prev };
          for (const u of usersData) if (!(u.id in next)) next[u.id] = u.can_invite;
          return next;
        });
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : t("common.error.loadFailed"));
      })
      .finally(() => setLoading(false));
  }, [roleFilter, tenantFilter, authorized, notAdmin]);

  async function handleSave(userId: string) {
    const token = localStorage.getItem("token");
    if (!token) return;

    const u = users.find((x) => x.id === userId);
    if (!u) return;

    const body: Record<string, unknown> = {};
    const tenantId = pendingTenants[userId];
    if (tenantId !== undefined && tenantId !== u.tenant_id) body.tenantId = tenantId;
    const roleId = pendingRoles[userId];
    if (roleId !== undefined && roleId !== u.role_id) body.roleId = roleId;
    const name = pendingNames[userId];
    if (name !== undefined && name !== (u.name ?? "")) body.name = name;
    const allTenants = pendingAllTenants[userId];
    if (allTenants !== undefined && allTenants !== u.can_access_all_tenants) body.canAccessAllTenants = allTenants;
    const invite = pendingInvite[userId];
    if (invite !== undefined && invite !== u.can_invite) body.canInvite = invite;
    if (Object.keys(body).length === 0) return;

    setSavingIds((prev) => new Set(prev).add(userId));
    setSaveErrors((prev) => { const n = { ...prev }; delete n[userId]; return n; });
    setSavedIds((prev) => { const n = new Set(prev); n.delete(userId); return n; });

    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setSaveErrors((prev) => ({
          ...prev,
          [userId]: (errBody as { error?: string }).error ?? t("common.error.generic", { status: res.status }),
        }));
        return;
      }

      const updated = (await res.json()) as {
        id: string;
        email: string;
        name: string | null;
        tenant_id: string | null;
        role_id: number;
        can_access_all_tenants: boolean;
        can_invite: boolean;
      };
      setUsers((prev) =>
        prev.map((x) => {
          if (x.id !== updated.id) return x;
          const tenant = tenants.find((c) => c.id === updated.tenant_id);
          const role = ROLES.find((r) => r.id === updated.role_id);
          return {
            ...x,
            tenant_id: updated.tenant_id,
            tenant_name: updated.tenant_id === null ? null : (tenant?.name ?? x.tenant_name),
            role_id: updated.role_id,
            role_name: role?.name ?? x.role_name,
            name: updated.name,
            can_access_all_tenants: updated.can_access_all_tenants,
            can_invite: updated.can_invite,
          };
        }),
      );
      setPendingNames((prev) => ({ ...prev, [userId]: updated.name ?? "" }));
      setPendingAllTenants((prev) => ({ ...prev, [userId]: updated.can_access_all_tenants }));
      setPendingInvite((prev) => ({ ...prev, [userId]: updated.can_invite }));
      setSavedIds((prev) => new Set(prev).add(userId));
      setTimeout(() => {
        setSavedIds((prev) => { const n = new Set(prev); n.delete(userId); return n; });
      }, 2000);
    } catch {
      setSaveErrors((prev) => ({ ...prev, [userId]: t("common.error.couldNotReachServer") }));
    } finally {
      setSavingIds((prev) => { const n = new Set(prev); n.delete(userId); return n; });
    }
  }

  // Permanent — one native confirm() naming the target's email, matching the
  // app's established single-confirm destructive-action pattern (e.g. the
  // media library's per-file/bulk "Delete permanently"). No PATCH-style
  // dirty/pending state: a delete has nothing to stage, it either happens or
  // it doesn't.
  async function handleDelete(u: User) {
    const token = localStorage.getItem("token");
    if (!token) return;

    if (!window.confirm(t("users.confirm.deleteUser", { email: u.email }))) {
      return;
    }

    setDeletingIds((prev) => new Set(prev).add(u.id));
    setDeleteErrors((prev) => { const n = { ...prev }; delete n[u.id]; return n; });

    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setDeleteErrors((prev) => ({
          ...prev,
          [u.id]: (errBody as { error?: string }).error ?? t("common.error.generic", { status: res.status }),
        }));
        return;
      }

      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      // Drop the now-deleted user's entries from every per-row pending map —
      // harmless to leave them, but there's no reason to keep state for a
      // row that no longer exists.
      setPendingTenants((prev) => { const n = { ...prev }; delete n[u.id]; return n; });
      setPendingRoles((prev) => { const n = { ...prev }; delete n[u.id]; return n; });
      setPendingNames((prev) => { const n = { ...prev }; delete n[u.id]; return n; });
      setPendingAllTenants((prev) => { const n = { ...prev }; delete n[u.id]; return n; });
      setPendingInvite((prev) => { const n = { ...prev }; delete n[u.id]; return n; });
    } catch {
      setDeleteErrors((prev) => ({ ...prev, [u.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setDeletingIds((prev) => { const n = new Set(prev); n.delete(u.id); return n; });
    }
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

    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      // No tenantId sent — the backend takes it from this caller's own
      // token for a tenant admin (any value here would be silently
      // overridden anyway), so this page never even offers a picker.
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, roleId: inviteRoleId }),
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

  async function handleRevokeInvite(invitation: Invitation) {
    const token = localStorage.getItem("token");
    if (!token) return;
    setRevokingInviteIds((prev) => new Set(prev).add(invitation.id));
    setRevokeInviteErrors((prev) => { const n = { ...prev }; delete n[invitation.id]; return n; });
    try {
      const res = await fetch(`/api/invitations/${invitation.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setRevokeInviteErrors((prev) => ({
          ...prev,
          [invitation.id]: (errBody as { error?: string }).error ?? t("common.error.generic", { status: res.status }),
        }));
        return;
      }
      setInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
    } catch {
      setRevokeInviteErrors((prev) => ({ ...prev, [invitation.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setRevokingInviteIds((prev) => { const n = new Set(prev); n.delete(invitation.id); return n; });
    }
  }

  if (!authorized) return null;

  if (notAdmin) {
    return (
      <AppShell active="users" title={t("nav.users")}>
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

  // Client-side lockout mirror of the server's 409 — always safe to compute
  // from whatever's currently in `users`, never a wider "true" count that
  // could show delete when the server would 409. Reasoning: a role-1 (super
  // admin) row has tenant_id null, so it's excluded the moment EITHER filter
  // narrows to anything (roleFilter to a non-1 role drops it directly;
  // tenantFilter to any real tenant drops it too, since null never matches a
  // real tenant id). The only state where a role-1 row is visible at all is
  // "no tenant filter, and role filter empty-or-1" — and in exactly that
  // state, neither filter excludes any real super admin, so this count is
  // the true system-wide count, not a partial one. Filtered-out states can
  // only ever undercount (never overcount), so this can only ever be overly
  // cautious about hiding Delete, never wrong in the unsafe direction.
  const superAdminCount = users.filter((x) => x.role_id === 1).length;

  const countPill =
    !loading && !loadError ? (
      <span className="dam-glass inline-flex h-9 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium text-ink">
        {t("users.count", { count: users.length })}
      </span>
    ) : undefined;

  return (
    <AppShell active="users" title={t("nav.users")} actions={countPill}>
      {/* Filter toolbar — lighter frosted glass than the top bar */}
      <div className="dam-glass-light mb-6 flex flex-wrap items-center gap-3 rounded-[12px] px-4 py-3">
        <Select
          ariaLabel={t("users.filters.roleAriaLabel")}
          value={roleFilter}
          onChange={setRoleFilter}
          options={[{ value: "", label: t("users.filters.allRoles") }, ...ROLES.map((r) => ({ value: String(r.id), label: r.name }))]}
          className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card py-1.5 px-3 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
        />

        {/* Super-admin only — a tenant admin's list is already pinned to
            their own tenant server-side, so there's nothing for them to
            filter (see GET /api/users, which silently ignores tenantId
            for non-super-admins regardless of what this control would send). */}
        {isSuperAdmin && (
          <Select
            ariaLabel={t("users.filters.tenantAriaLabel")}
            value={tenantFilter}
            onChange={setTenantFilter}
            options={[{ value: "", label: t("users.filters.allTenants") }, ...tenants.map((c) => ({ value: c.id, label: c.name }))]}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card py-1.5 px-3 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
          />
        )}
      </div>

      <p className="mb-4 text-xs text-slate">
        {t("users.help.company")} {t("users.help.role")}
        {!isSuperAdmin && ` ${t("users.help.tenantAdminRoleLimit")}`}
      </p>

      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && (
        <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-line/70">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("users.table.headerUser")}
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("common.name")}
                </th>
                <th
                  className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate"
                  title={t("users.table.companyTooltip")}
                >
                  {t("common.company")} <span className="normal-case font-normal text-border-soft">{t("users.table.companyHint")}</span>
                </th>
                <th
                  className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate"
                  title={t("users.table.roleTooltip")}
                >
                  {t("common.role")} <span className="normal-case font-normal text-border-soft">{t("users.table.roleHint")}</span>
                </th>
                <th
                  className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate"
                  title={t("users.table.allTenantsTooltip")}
                >
                  {t("users.table.headerAllTenants")}
                </th>
                <th
                  className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate"
                  title={t("users.table.canInviteTooltip")}
                >
                  {t("users.table.headerCanInvite")}
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("users.table.headerJoined")}
                </th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === selfId;
                // A tenant admin can never edit another admin (role 1 or 2) —
                // server-enforced (PATCH /api/users/[id] 403s regardless), but
                // the row is locked here too so it reads the same as the "you"
                // row rather than looking editable and failing on Save.
                const isLockedPeerAdmin = !isSuperAdmin && !isSelf && (u.role_id === 1 || u.role_id === 2);
                const rowLocked = isSelf || isLockedPeerAdmin;
                const saving = savingIds.has(u.id);
                const saved = savedIds.has(u.id);
                const error = saveErrors[u.id];
                const pendingTenant = u.id in pendingTenants ? pendingTenants[u.id] : u.tenant_id;
                const pendingRole = pendingRoles[u.id] ?? u.role_id;
                const pendingName = pendingNames[u.id] ?? (u.name ?? "");
                const pendingAllTenantsFlag = pendingAllTenants[u.id] ?? u.can_access_all_tenants;
                const pendingInviteFlag = pendingInvite[u.id] ?? u.can_invite;
                const tenantDirty = pendingTenant !== u.tenant_id;
                const roleDirty = pendingRole !== u.role_id;
                const nameDirty = pendingName !== (u.name ?? "");
                const allTenantsDirty = pendingAllTenantsFlag !== u.can_access_all_tenants;
                const inviteDirty = pendingInviteFlag !== u.can_invite;
                const isDirty = tenantDirty || roleDirty || nameDirty || allTenantsDirty || inviteDirty;
                // A tenant admin's own row-level edit surface is narrower than a
                // super admin's: Company is never editable by them (server 403s
                // regardless), and the Role dropdown below is restricted to the
                // roles they're actually allowed to assign.
                const roleOptions = isSuperAdmin
                  ? ROLES
                  : ROLES.filter((r) => TENANT_ADMIN_ASSIGNABLE_ROLE_IDS.has(r.id) || r.id === u.role_id);
                const initials = getInitials(u.name || u.email);

                // Delete visibility mirrors DELETE /api/users/[id]'s guards
                // exactly, so the button is never shown where the request
                // would 403/409: never on yourself, never on an admin-tier
                // target a tenant admin can't touch (isLockedPeerAdmin
                // already covers this — a plain tenant admin or a
                // cross-tenant one, neither may delete role 1/2), and never
                // on the last remaining super admin (server-enforced too;
                // this is the client-side mirror of that same count).
                const isLastSuperAdmin = u.role_id === 1 && superAdminCount <= 1;
                const canDelete = !isSelf && !isLockedPeerAdmin && !isLastSuperAdmin;
                const deleting = deletingIds.has(u.id);
                const deleteError = deleteErrors[u.id];

                return (
                  <tr
                    key={u.id}
                    className={`border-b border-surface-tint-2 last:border-b-0 transition-colors ${
                      isDirty ? "bg-surface-tint/50" : "hover:bg-white/40 dark:hover:bg-white/5"
                    }`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">
                          {initials ?? (
                            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M10 10a4 4 0 100-8 4 4 0 000 8zM2 18a8 8 0 1116 0H2z" />
                            </svg>
                          )}
                        </span>
                        <span className="text-sm text-ink">{u.email}</span>
                        {isSelf && (
                          <span className="inline-flex items-center rounded-full bg-surface-tint px-2 py-0.5 text-[10px] font-medium text-brand">
                            {t("common.you")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <input
                        type="text"
                        value={pendingName}
                        disabled={rowLocked || saving}
                        placeholder={t("users.table.noNamePlaceholder")}
                        maxLength={100}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPendingNames((prev) => ({ ...prev, [u.id]: val }));
                        }}
                        className={`w-40 rounded-[8px] border bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow placeholder:text-border-soft focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 ${
                          nameDirty
                            ? "border-brand ring-[3px] ring-brand/15"
                            : "border-line focus:border-brand focus:ring-brand/15"
                        }`}
                      />
                    </td>
                    <td className="px-5 py-3">
                      {isSuperAdmin ? (
                        <Select
                          ariaLabel={t("users.aria.companyFor", { email: u.email })}
                          value={pendingTenant ?? NONE_TENANT}
                          disabled={rowLocked || saving}
                          onChange={(v) => {
                            const val = v === NONE_TENANT ? null : v;
                            setPendingTenants((prev) => ({ ...prev, [u.id]: val }));
                          }}
                          options={[
                            { value: NONE_TENANT, label: t("common.none") },
                            ...tenants.map((c) => ({ value: c.id, label: c.name })),
                          ]}
                          className={`flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 ${
                            tenantDirty
                              ? "border-brand ring-[3px] ring-brand/15"
                              : "border-line focus:border-brand focus:ring-brand/15"
                          }`}
                        />
                      ) : (
                        // Tenant admins can never set/change a tenant (server 403s
                        // regardless) — shown as plain text, not a disabled-looking
                        // editable control, since every user in their list already
                        // shares their own tenant.
                        <span className="text-sm text-ink">{u.tenant_name ?? "—"}</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Select
                        ariaLabel={t("users.aria.roleFor", { email: u.email })}
                        value={String(pendingRole)}
                        disabled={rowLocked || saving}
                        onChange={(v) => {
                          const val = Number(v);
                          setPendingRoles((prev) => ({ ...prev, [u.id]: val }));
                        }}
                        options={roleOptions.map((r) => ({ value: String(r.id), label: r.name }))}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 ${
                          roleDirty
                            ? "border-brand ring-[3px] ring-brand/15"
                            : "border-line focus:border-brand focus:ring-brand/15"
                        }`}
                      />
                    </td>
                    <td className="px-5 py-3">
                      {u.role_id === 1 ? (
                        // Role 1 always has cross-tenant access by definition —
                        // hardcoded, never dependent on the column, so there's nothing to toggle.
                        <span className="inline-flex items-center rounded-full bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300">
                          {t("common.always")}
                        </span>
                      ) : isSuperAdmin ? (
                        // Only a super admin may toggle the flag (server-enforced
                        // 403 for everyone else — the self-escalation guard);
                        // wired through the same pending/dirty/Save flow as the
                        // other columns, not an instant write.
                        <button
                          type="button"
                          role="switch"
                          aria-checked={pendingAllTenantsFlag}
                          aria-label={t("users.aria.allTenantAccessFor", { email: u.email })}
                          disabled={isSelf || saving}
                          onClick={() =>
                            setPendingAllTenants((prev) => ({ ...prev, [u.id]: !pendingAllTenantsFlag }))
                          }
                          className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          style={{
                            backgroundColor: pendingAllTenantsFlag
                              ? "var(--color-brand)"
                              : "var(--color-input-border)",
                          }}
                        >
                          <span
                            className="inline-block h-3.5 w-3.5 transform rounded-full bg-card shadow transition-transform"
                            style={{
                              transform: pendingAllTenantsFlag ? "translateX(18px)" : "translateX(3px)",
                            }}
                          />
                        </button>
                      ) : (
                        // Non-super-admin viewers see the flag read-only.
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                            u.can_access_all_tenants
                              ? "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300"
                              : "bg-table-header text-slate"
                          }`}
                        >
                          {u.can_access_all_tenants ? t("users.table.headerAllTenants") : "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {u.role_id === 1 ? (
                        // Role 1 can always invite — hardcoded, never
                        // dependent on the column, so there's nothing to toggle.
                        <span className="inline-flex items-center rounded-full bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300">
                          {t("common.always")}
                        </span>
                      ) : isSuperAdmin ? (
                        // Only a super admin may toggle the flag (server-enforced
                        // 403 for everyone else, including on their own row —
                        // the self-escalation guard); wired through the same
                        // pending/dirty/Save flow as the other columns.
                        <button
                          type="button"
                          role="switch"
                          aria-checked={pendingInviteFlag}
                          aria-label={t("users.aria.inviteAccessFor", { email: u.email })}
                          disabled={isSelf || saving}
                          onClick={() =>
                            setPendingInvite((prev) => ({ ...prev, [u.id]: !pendingInviteFlag }))
                          }
                          className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          style={{
                            backgroundColor: pendingInviteFlag
                              ? "var(--color-brand)"
                              : "var(--color-input-border)",
                          }}
                        >
                          <span
                            className="inline-block h-3.5 w-3.5 transform rounded-full bg-card shadow transition-transform"
                            style={{
                              transform: pendingInviteFlag ? "translateX(18px)" : "translateX(3px)",
                            }}
                          />
                        </button>
                      ) : (
                        // Non-super-admin viewers see the flag read-only.
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                            u.can_invite
                              ? "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300"
                              : "bg-table-header text-slate"
                          }`}
                        >
                          {u.can_invite ? t("users.table.headerCanInvite") : "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-slate">
                      {formatDate(u.created_at)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2.5">
                        {error && (
                          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
                        )}
                        {deleteError && (
                          <span className="text-xs text-red-600 dark:text-red-400">{deleteError}</span>
                        )}
                        {saved && (
                          <span className="text-xs text-green-600 dark:text-green-400">{t("common.saved")}</span>
                        )}
                        {rowLocked ? (
                          <span
                            className="flex h-7 w-7 items-center justify-center text-border-soft"
                            title={
                              isSelf
                                ? t("users.table.lockedSelfTooltip")
                                : t("users.table.lockedPeerAdminTooltip")
                            }
                          >
                            <LockIcon />
                          </span>
                        ) : (
                          <button
                            onClick={() => handleSave(u.id)}
                            disabled={saving || !isDirty}
                            className={`cursor-pointer rounded-[8px] px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                              isDirty
                                ? "bg-brand text-white shadow-[0_4px_12px_var(--shadow-color-brand)] hover:bg-brand-hover disabled:opacity-60"
                                : "border border-line bg-white/60 dark:bg-white/10 text-slate disabled:opacity-60"
                            }`}
                          >
                            {saving ? t("common.saving") : t("common.save")}
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleDelete(u)}
                            disabled={deleting}
                            title={t("users.aria.deleteUser", { email: u.email })}
                            aria-label={t("users.aria.deleteUser", { email: u.email })}
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] border border-red-200 dark:border-red-800/60 bg-white/60 dark:bg-white/10 text-red-600 dark:text-red-400 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {deleting ? <Spinner /> : <TrashIcon />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {users.length === 0 && (
            <p className="px-5 py-6 text-sm text-slate">{t("users.table.empty")}</p>
          )}
        </div>
      )}

      {/* Invite a teammate — non-super-admin, and only when this caller's
          own token carries canInvite: true. A super admin manages invites
          (any tenant, any invitable role) on /admin/tenants instead;
          duplicating that here would just be a second surface to keep in
          sync. Only editor/viewer are offered — this mirrors, but does not
          replace, POST /api/invitations' own server-side tier check, which
          still forces tenantId from this caller's token regardless of
          anything sent. */}
      {!isSuperAdmin && canInviteSelf && (
        <div className="mt-8">
          <h2 className={`mb-3 text-sm font-semibold text-ink`}>{t("users.invite.heading")}</h2>

          <form
            onSubmit={handleInvite}
            className="dam-glass mb-6 flex flex-col gap-3 rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]"
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                <label htmlFor="teammate-invite-email" className="text-xs font-medium text-slate">
                  {t("common.email")}
                </label>
                <input
                  id="teammate-invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="teammate-invite-role" className="text-xs font-medium text-slate">
                  {t("common.role")}
                </label>
                <Select
                  id="teammate-invite-role"
                  value={String(inviteRoleId)}
                  onChange={(v) => setInviteRoleId(Number(v) as 3 | 4)}
                  options={[
                    { value: "3", label: t("common.role.editor") },
                    { value: "4", label: t("common.role.viewer") },
                  ]}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                />
              </div>

              <button
                type="submit"
                disabled={inviting}
                className="cursor-pointer rounded-[8px] bg-brand px-4 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {inviting ? t("common.invite.sending") : t("common.invite.submit")}
              </button>
            </div>
            {inviteError && <p className="text-xs text-red-600 dark:text-red-400">{inviteError}</p>}
            {inviteSuccess && <p className="text-xs text-emerald-700 dark:text-emerald-300">{inviteSuccess}</p>}
          </form>

          <h2 className="mb-3 text-sm font-semibold text-ink">{t("users.invite.pendingHeading")}</h2>
          {invitationsLoading && <p className="text-sm text-slate">{t("common.loading")}</p>}
          {invitationsError && <p className="text-sm text-red-600 dark:text-red-400">{invitationsError}</p>}
          {!invitationsLoading && !invitationsError && (
            <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
              <table className="min-w-full">
                <thead>
                  <tr className="border-b border-line/70">
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.email")}</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.role")}</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.status")}</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.expires")}</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((inv) => {
                    const revoking = revokingInviteIds.has(inv.id);
                    const error = revokeInviteErrors[inv.id];
                    return (
                      <tr key={inv.id} className="border-b border-surface-tint-2 last:border-b-0 transition-colors hover:bg-white/40 dark:hover:bg-white/5">
                        <td className="px-5 py-3 text-sm text-ink">{inv.email}</td>
                        <td className="px-5 py-3 text-sm capitalize text-ink">{inv.role.name}</td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                              inv.status === "pending"
                                ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                                : "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                            }`}
                          >
                            {inv.status === "pending" ? t("common.pending") : t("common.expired")}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-sm text-ink">{formatDate(inv.expiresAt)}</td>
                        <td className="px-5 py-3 text-right">
                          <div className="flex items-center justify-end gap-2.5">
                            {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
                            <button
                              onClick={() => handleRevokeInvite(inv)}
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
          )}
        </div>
      )}
    </AppShell>
  );
}
