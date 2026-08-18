"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import CollectionTreePicker from "@/components/CollectionTreePicker";
import Select from "@/components/Select";
import { useTranslation } from "@/lib/i18n";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

type AccessLevel = "view" | "download";
type ExpiryOption = "1d" | "7d" | "30d" | "never";

const EXPIRY_LABEL_KEYS: Record<ExpiryOption, string> = {
  "1d": "shares.expiry.1d",
  "7d": "shares.expiry.7d",
  "30d": "shares.expiry.30d",
  never: "shares.expiry.never",
};

interface Target {
  type: "collection" | "resource";
  id: string;
  name: string;
}

interface Share {
  id: string;
  target: Target;
  accessLevel: AccessLevel;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  label: string | null;
  hasLink: boolean;
}

interface ResourceOption {
  id: string;
  original_filename: string;
  mime_type: string;
}

interface CreatedShare {
  url: string;
  target: Target;
  accessLevel: AccessLevel;
  expiresAt: string | null;
}

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shareStatus(share: Share, t: TFunc): { label: string; className: string } {
  if (share.revoked) {
    return { label: t("shares.status.revoked"), className: "bg-table-header text-slate" };
  }
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return { label: t("common.expired"), className: "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300" };
  }
  return { label: t("shares.status.active"), className: "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" };
}

function CopyIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="7" y="7" width="9" height="10" rx="1.5" strokeLinejoin="round" />
      <path d="M4.5 13V5.5A1.5 1.5 0 016 4h7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


function InfoIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 9.25v4.25" strokeLinecap="round" />
      <circle cx="10" cy="6.75" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function SharesPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  // A tenant admin's Resource-target search reuses GET /api/media, which
  // stays requireSuperAdmin (the media library is a genuinely global,
  // cross-tenant inventory — see the classification note in STATE.md).
  // Rather than show a "Resource" option that always 403s for them, this
  // page only offers Collection as a share target for a non-super-admin;
  // CollectionTreePicker's own GET /api/collections is already tenant-scoped.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Create-share form state
  const [targetType, setTargetType] = useState<"collection" | "resource">("collection");
  const [selectedCollectionId, setSelectedCollectionId] = useState("");

  const [resourceQuery, setResourceQuery] = useState("");
  const [resourceResults, setResourceResults] = useState<ResourceOption[]>([]);
  const [resourceSearching, setResourceSearching] = useState(false);
  const [selectedResource, setSelectedResource] = useState<ResourceOption | null>(null);
  const resourceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [accessLevel, setAccessLevel] = useState<AccessLevel>("view");
  const [expiresIn, setExpiresIn] = useState<ExpiryOption>("7d");
  const [label, setLabel] = useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdShare, setCreatedShare] = useState<CreatedShare | null>(null);
  const [copied, setCopied] = useState(false);

  // Row actions
  const [revokingIds, setRevokingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [copyingLinkIds, setCopyingLinkIds] = useState<Set<string>>(new Set());
  const [copiedLinkIds, setCopiedLinkIds] = useState<Set<string>>(new Set());

  function authHeaders(): Record<string, string> {
    const token = localStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function loadShares() {
    setLoading(true);
    setLoadError(null);
    fetch("/api/shares", { headers: authHeaders() })
      .then((r) => {
        if (!r.ok) throw new Error(t("shares.error.loadHttp", { status: r.status }));
        return r.json() as Promise<{ shares: Share[] }>;
      })
      .then((data) => setShares(data.shares))
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : t("shares.error.loadGeneric"));
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
    // Shares are now tenant-scoped (POST/GET/PATCH/DELETE /api/shares, as of
    // this pass) — a tenant admin may manage shares within their own reach,
    // same as a super admin across every tenant. canAdmin covers both.
    if (!payload?.canAdmin) {
      setNotAdmin(true);
      setAuthorized(true);
      return;
    }
    setIsSuperAdmin(payload?.roleName === "super_admin");
    setAuthorized(true);
    loadShares();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Debounced resource search (300ms), reusing the admin-only media listing endpoint.
  useEffect(() => {
    if (targetType !== "resource") return;
    if (resourceDebounceRef.current) clearTimeout(resourceDebounceRef.current);
    if (!resourceQuery.trim()) {
      setResourceResults([]);
      return;
    }
    resourceDebounceRef.current = setTimeout(() => {
      setResourceSearching(true);
      fetch(`/api/media?q=${encodeURIComponent(resourceQuery.trim())}`, { headers: authHeaders() })
        .then((r) => (r.ok ? (r.json() as Promise<{ files: ResourceOption[] }>) : { files: [] }))
        .then((data) => setResourceResults(data.files))
        .finally(() => setResourceSearching(false));
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceQuery, targetType]);

  function resetCreateForm() {
    setSelectedCollectionId("");
    setSelectedResource(null);
    setResourceQuery("");
    setResourceResults([]);
    setAccessLevel("view");
    setExpiresIn("7d");
    setLabel("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);

    const targetId = targetType === "collection" ? selectedCollectionId : selectedResource?.id;
    if (!targetId) {
      setCreateError(targetType === "collection" ? t("shares.create.pickCollection") : t("shares.create.pickResource"));
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          ...(targetType === "collection" ? { collectionId: targetId } : { resourceId: targetId }),
          accessLevel,
          expiresIn,
          ...(label.trim() ? { label: label.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      setCreatedShare({
        url: body.url,
        target: body.target,
        accessLevel: body.accessLevel,
        expiresAt: body.expiresAt,
      });
      setCopied(false);
      resetCreateForm();
      loadShares();
    } catch {
      setCreateError(t("common.error.couldNotReachServer"));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!createdShare) return;
    try {
      await navigator.clipboard.writeText(createdShare.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the link is still visible to copy manually.
    }
  }

  async function handleRevoke(share: Share) {
    const ok = window.confirm(t("shares.revoke.confirm"));
    if (!ok) return;

    setRevokingIds((prev) => new Set(prev).add(share.id));
    setRowErrors((prev) => { const n = { ...prev }; delete n[share.id]; return n; });
    try {
      const res = await fetch(`/api/shares/${share.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ revoked: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowErrors((prev) => ({ ...prev, [share.id]: (body as { error?: string }).error ?? t("common.error.generic", { status: res.status }) }));
        return;
      }
      setShares((prev) => prev.map((s) => (s.id === share.id ? { ...s, revoked: true } : s)));
    } catch {
      setRowErrors((prev) => ({ ...prev, [share.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setRevokingIds((prev) => { const n = new Set(prev); n.delete(share.id); return n; });
    }
  }

  async function handleDelete(share: Share) {
    const ok = window.confirm(t("shares.delete.confirm"));
    if (!ok) return;

    setDeletingIds((prev) => new Set(prev).add(share.id));
    try {
      const res = await fetch(`/api/shares/${share.id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowErrors((prev) => ({ ...prev, [share.id]: (body as { error?: string }).error ?? t("common.error.generic", { status: res.status }) }));
        return;
      }
      setShares((prev) => prev.filter((s) => s.id !== share.id));
    } catch {
      setRowErrors((prev) => ({ ...prev, [share.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setDeletingIds((prev) => { const n = new Set(prev); n.delete(share.id); return n; });
    }
  }

  // Only ever called for a row where hasLink is true. Fetches and decrypts the
  // token server-side (GET /api/shares/[id]/link, admin-only) — this is the
  // re-copy path; it never touches token_hash or the public validation route.
  async function handleCopyLink(share: Share) {
    setCopyingLinkIds((prev) => new Set(prev).add(share.id));
    setRowErrors((prev) => { const n = { ...prev }; delete n[share.id]; return n; });
    try {
      const res = await fetch(`/api/shares/${share.id}/link`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowErrors((prev) => ({ ...prev, [share.id]: (body as { error?: string }).error ?? t("common.error.generic", { status: res.status }) }));
        return;
      }
      await navigator.clipboard.writeText(body.url);
      setCopiedLinkIds((prev) => new Set(prev).add(share.id));
      setTimeout(() => {
        setCopiedLinkIds((prev) => { const n = new Set(prev); n.delete(share.id); return n; });
      }, 2000);
    } catch {
      setRowErrors((prev) => ({ ...prev, [share.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setCopyingLinkIds((prev) => { const n = new Set(prev); n.delete(share.id); return n; });
    }
  }

  if (!authorized) return null;

  if (notAdmin) {
    return (
      <AppShell active="shares" title={t("nav.shares")}>
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
      {t("shares.count", { count: shares.length })}
    </span>
  ) : undefined;

  return (
    <AppShell active="shares" title={t("nav.shares")} actions={countPill}>
      {/* Create share */}
      <form
        onSubmit={handleCreate}
        className="dam-glass mb-6 flex flex-col gap-4 rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]"
      >
        <p className="text-sm font-semibold text-ink">{t("shares.create.heading")}</p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate">{t("shares.create.targetTypeLabel")}</label>
            <Select
              value={targetType}
              onChange={(v) => {
                setTargetType(v as "collection" | "resource");
                setCreateError(null);
              }}
              options={[
                { value: "collection", label: t("shares.create.targetCollection") },
                ...(isSuperAdmin ? [{ value: "resource", label: t("shares.create.targetResource") }] : []),
              ]}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>

          {targetType === "collection" ? (
            <div className="flex min-w-[240px] flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-slate">{t("shares.create.targetCollection")}</label>
              <CollectionTreePicker
                value={selectedCollectionId || null}
                onChange={(id) => setSelectedCollectionId(id ?? "")}
                placeholder={t("shares.create.collectionPlaceholder")}
              />
            </div>
          ) : (
            <div className="relative flex min-w-[280px] flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-slate">{t("shares.create.targetResource")}</label>
              {selectedResource ? (
                <div className="flex items-center gap-2 rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink">
                  <span className="truncate">{selectedResource.original_filename}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedResource(null)}
                    className="ml-auto shrink-0 cursor-pointer text-xs text-brand hover:underline"
                  >
                    {t("shares.create.change")}
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={resourceQuery}
                    onChange={(e) => setResourceQuery(e.target.value)}
                    placeholder={t("shares.create.resourceSearchPlaceholder")}
                    className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                  />
                  {(resourceSearching || resourceResults.length > 0) && (
                    <div className="absolute left-0 top-full z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-[8px] border border-line bg-card shadow-lg">
                      {resourceSearching && (
                        <p className="px-3 py-2 text-xs text-slate">{t("shares.create.searching")}</p>
                      )}
                      {!resourceSearching && resourceResults.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => {
                            setSelectedResource(r);
                            setResourceResults([]);
                          }}
                          className="block w-full cursor-pointer truncate px-3 py-2 text-left text-sm text-ink hover:bg-mist"
                        >
                          {r.original_filename}
                        </button>
                      ))}
                      {!resourceSearching && resourceResults.length === 0 && (
                        <p className="px-3 py-2 text-xs text-slate">{t("shares.create.noMatches")}</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate">{t("shares.access.label")}</label>
            <Select
              value={accessLevel}
              onChange={(v) => setAccessLevel(v as AccessLevel)}
              options={[
                { value: "view", label: t("shares.access.viewOnly") },
                { value: "download", label: t("common.download") },
              ]}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate">{t("common.expires")}</label>
            <Select
              value={expiresIn}
              onChange={(v) => setExpiresIn(v as ExpiryOption)}
              options={(Object.entries(EXPIRY_LABEL_KEYS) as [ExpiryOption, string][]).map(([value, labelKey]) => ({
                value,
                label: t(labelKey),
              }))}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>

          <div className="flex min-w-[180px] flex-col gap-1">
            <label className="text-xs font-medium text-slate">{t("shares.create.labelField")}</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("shares.create.labelPlaceholder")}
              maxLength={255}
              className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>

          <button
            type="submit"
            disabled={creating}
            className="cursor-pointer rounded-[8px] bg-brand px-4 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? t("shares.create.creating") : t("shares.create.submit")}
          </button>
        </div>

        {expiresIn === "never" && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t("shares.create.neverExpiryCaution")}
          </p>
        )}
        {createError && <p className="text-xs text-red-600 dark:text-red-400">{createError}</p>}

        {createdShare && (
          <div className="rounded-[10px] border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-4">
            <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
              {createdShare.target.type === "collection"
                ? t("shares.create.successBannerCollection", { name: createdShare.target.name })
                : t("shares.create.successBannerFile", { name: createdShare.target.name })}
            </p>
            <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-300">
              <InfoIcon />
              <span>
                {t("shares.create.copyNowHint")}
              </span>
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={createdShare.url}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded-[8px] border border-emerald-300 dark:border-emerald-700 bg-card px-3 py-1.5 text-xs text-ink outline-none"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[8px] bg-emerald-600 dark:bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 dark:hover:bg-emerald-500"
              >
                <CopyIcon />
                {copied ? t("shares.create.copied") : t("shares.create.copy")}
              </button>
              <button
                type="button"
                onClick={() => setCreatedShare(null)}
                className="shrink-0 cursor-pointer rounded-[8px] border border-emerald-300 dark:border-emerald-700 bg-card px-3 py-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
              >
                {t("shares.create.done")}
              </button>
            </div>
          </div>
        )}
      </form>

      {/* Shares list */}
      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && (
        <>
          <p className="mb-2 flex items-center gap-1.5 text-xs text-slate">
            <InfoIcon />
            {t("shares.list.copyLinkHint")}
          </p>
          <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-line/70">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("shares.table.headerTarget")}</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("shares.access.label")}</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.status")}</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.expires")}</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("shares.table.headerCreated")}</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("shares.table.headerLastUsed")}</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {shares.map((share) => {
                const status = shareStatus(share, t);
                const revoking = revokingIds.has(share.id);
                const deleting = deletingIds.has(share.id);
                const error = rowErrors[share.id];
                return (
                  <tr key={share.id} className="border-b border-surface-tint-2 last:border-b-0 transition-colors hover:bg-white/40 dark:hover:bg-white/5">
                    <td className="px-5 py-3">
                      <p className="text-sm text-ink">{share.target.name}</p>
                      <p className="text-xs text-slate">
                        {share.target.type === "collection" ? t("shares.create.targetCollection") : t("shares.table.targetTypeFile")}
                        {share.label ? ` · ${share.label}` : ""}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-sm text-ink capitalize">{share.accessLevel}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-ink">
                      {share.expiresAt ? formatDateTime(share.expiresAt) : t("shares.expiry.never")}
                    </td>
                    <td className="px-5 py-3 text-sm text-ink">{formatDateTime(share.createdAt)}</td>
                    <td className="px-5 py-3 text-sm text-ink">{formatDateTime(share.lastUsedAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2.5">
                        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
                        {share.hasLink && (
                          <button
                            onClick={() => handleCopyLink(share)}
                            disabled={copyingLinkIds.has(share.id)}
                            className="cursor-pointer rounded-[8px] border border-line bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {copyingLinkIds.has(share.id)
                              ? t("shares.table.copyingLink")
                              : copiedLinkIds.has(share.id)
                                ? t("shares.create.copied")
                                : t("shares.table.copyLink")}
                          </button>
                        )}
                        <button
                          onClick={() => handleRevoke(share)}
                          disabled={share.revoked || revoking}
                          className="cursor-pointer rounded-[8px] border border-line bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {revoking ? t("shares.table.revoking") : t("shares.table.revoke")}
                        </button>
                        <button
                          onClick={() => handleDelete(share)}
                          disabled={deleting}
                          className="cursor-pointer rounded-[8px] border border-red-200 dark:border-red-800/60 bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {deleting ? t("common.deleting") : t("common.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shares.length === 0 && (
            <p className="px-5 py-6 text-sm text-slate">{t("shares.table.empty")}</p>
          )}
          </div>
        </>
      )}
    </AppShell>
  );
}
