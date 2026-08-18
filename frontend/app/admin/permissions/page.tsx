"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import Select from "@/components/Select";
import { useTranslation } from "@/lib/i18n";

interface Tenant {
  id: string;
  name: string;
}

interface PermissionRow {
  key: string;
  default: boolean;
  override: boolean | null;
  enabled: boolean;
}

interface MatrixResponse {
  tenantId: string;
  tenantName: string;
  editor: PermissionRow[];
  viewer: PermissionRow[];
}

// Display order + labels — the union of both role key lists, editor-only
// keys first, matching the order the task itself gave them in. A key not in
// a given role's own list (e.g. "download" for editor) simply has no cell
// for that column — never a toggle that would 403 if clicked.
const DISPLAY_ORDER: { key: string; labelKey: string; editor: boolean; viewer: boolean }[] = [
  { key: "upload", labelKey: "permissions.action.upload", editor: true, viewer: false },
  { key: "edit_metadata", labelKey: "common.editMetadata", editor: true, viewer: false },
  { key: "rename_asset", labelKey: "permissions.action.renameAsset", editor: true, viewer: false },
  { key: "regenerate_thumbnail", labelKey: "permissions.action.regenerateThumbnail", editor: true, viewer: false },
  { key: "remove_from_collection", labelKey: "permissions.action.removeFromCollection", editor: true, viewer: false },
  { key: "add_to_collection", labelKey: "permissions.action.addToCollection", editor: true, viewer: false },
  { key: "create_share", labelKey: "permissions.action.createShare", editor: true, viewer: true },
  { key: "create_collection", labelKey: "permissions.action.createCollection", editor: true, viewer: false },
  { key: "rename_collection", labelKey: "permissions.action.renameCollection", editor: true, viewer: false },
  { key: "delete_permanently", labelKey: "common.deletePermanently", editor: true, viewer: false },
  { key: "download", labelKey: "permissions.action.downloadFiles", editor: false, viewer: true },
  { key: "view_metadata", labelKey: "permissions.action.viewMetadata", editor: false, viewer: true },
];

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}


function Toggle({
  checked,
  disabled,
  onClick,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{ backgroundColor: checked ? "var(--color-brand)" : "var(--color-input-border)" }}
    >
      <span
        className="inline-block h-3.5 w-3.5 transform rounded-full bg-card shadow transition-transform"
        style={{ transform: checked ? "translateX(18px)" : "translateX(3px)" }}
      />
    </button>
  );
}

function PermissionCell({
  row,
  roleId,
  tenantId,
  isSuperAdmin,
  onChanged,
}: {
  row: PermissionRow | undefined;
  roleId: 3 | 4;
  tenantId: string;
  isSuperAdmin: boolean;
  onChanged: (roleId: 3 | 4, updated: PermissionRow) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!row) {
    return <span className="text-sm text-border-soft">—</span>;
  }

  async function handleToggle() {
    if (!row) return;
    const token = localStorage.getItem("token");
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/permissions${isSuperAdmin ? `?tenantId=${tenantId}` : ""}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tenantId: isSuperAdmin ? tenantId : undefined,
          roleId,
          permissionKey: row.key,
          enabled: !row.enabled,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      onChanged(roleId, body as PermissionRow);
    } catch {
      setError(t("common.error.couldNotReachServer"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Toggle checked={row.enabled} disabled={busy} onClick={handleToggle} label={t("permissions.aria.toggle", { key: row.key })} />
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}

export default function PermissionsPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resettingAll, setResettingAll] = useState(false);
  const [resetAllError, setResetAllError] = useState<string | null>(null);

  function loadMatrix(tenantId?: string) {
    const token = localStorage.getItem("token");
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    const qs = tenantId ? `?tenantId=${tenantId}` : "";
    fetch(`/api/permissions${qs}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error(t("permissions.error.loadHttp", { status: r.status }));
        return r.json() as Promise<MatrixResponse>;
      })
      .then((data) => setMatrix(data))
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : t("permissions.error.loadGeneric"));
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
    if (!payload?.canAdmin) {
      setNotAdmin(true);
      setAuthorized(true);
      return;
    }
    const superAdmin = payload?.roleName === "super_admin";
    setIsSuperAdmin(superAdmin);
    setAuthorized(true);

    if (superAdmin) {
      fetch("/api/tenants", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Tenant[]) => {
          setTenants(rows);
          if (rows.length > 0) {
            setSelectedTenantId(rows[0].id);
            loadMatrix(rows[0].id);
          } else {
            setLoading(false);
          }
        })
        .catch(() => setLoading(false));
    } else {
      loadMatrix();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  function handleTenantChange(tenantId: string) {
    setSelectedTenantId(tenantId);
    loadMatrix(tenantId);
  }

  function handleCellChanged(roleId: 3 | 4, updated: PermissionRow) {
    setMatrix((prev) => {
      if (!prev) return prev;
      const key = roleId === 3 ? "editor" : "viewer";
      return {
        ...prev,
        [key]: prev[key].map((r) => (r.key === updated.key ? updated : r)),
      };
    });
  }

  async function handleResetAll() {
    if (!matrix) return;
    const ok = window.confirm(
      t("permissions.resetAll.confirm", { tenant: matrix.tenantName }),
    );
    if (!ok) return;
    const token = localStorage.getItem("token");
    if (!token) return;
    setResettingAll(true);
    setResetAllError(null);
    try {
      const params = new URLSearchParams({ all: "true" });
      if (isSuperAdmin) params.set("tenantId", matrix.tenantId);
      const res = await fetch(`/api/permissions?${params.toString()}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setResetAllError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      setMatrix((prev) =>
        prev
          ? {
              ...prev,
              editor: prev.editor.map((r) => ({ ...r, override: null, enabled: r.default })),
              viewer: prev.viewer.map((r) => ({ ...r, override: null, enabled: r.default })),
            }
          : prev,
      );
    } catch {
      setResetAllError(t("common.error.couldNotReachServer"));
    } finally {
      setResettingAll(false);
    }
  }

  if (!authorized) return null;

  if (notAdmin) {
    return (
      <AppShell active="permissions" title={t("nav.permissions")}>
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

  const tenantPicker = isSuperAdmin ? (
    <Select
      ariaLabel={t("common.company")}
      value={selectedTenantId}
      onChange={handleTenantChange}
      options={tenants.map((tn) => ({ value: tn.id, label: tn.name }))}
      className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
    />
  ) : undefined;

  return (
    <AppShell active="permissions" title={t("nav.permissions")} actions={tenantPicker}>
      <p className="mb-4 max-w-2xl text-xs text-slate">
        {t("permissions.header.description", { tenant: matrix?.tenantName ?? t("permissions.header.thisCompanyFallback") })}
      </p>

      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && matrix && (
        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">{t("permissions.matrixHeading")}</h2>
            <div className="flex items-center gap-2">
              {resetAllError && <span className="text-xs text-red-600 dark:text-red-400">{resetAllError}</span>}
              <button
                type="button"
                onClick={handleResetAll}
                disabled={resettingAll}
                className="cursor-pointer rounded-[8px] border border-red-200 dark:border-red-800/60 bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {resettingAll ? t("permissions.resetAll.resetting") : t("permissions.resetAll.submit")}
              </button>
            </div>
          </div>
          <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-line/70">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("permissions.table.headerAction")}
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("common.role.editor")}
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("common.role.viewer")}
                </th>
              </tr>
            </thead>
            <tbody>
              {DISPLAY_ORDER.map((row) => {
                const editorRow = row.editor ? matrix.editor.find((r) => r.key === row.key) : undefined;
                const viewerRow = row.viewer ? matrix.viewer.find((r) => r.key === row.key) : undefined;
                return (
                  <tr key={row.key} className="border-b border-surface-tint-2 last:border-b-0">
                    <td className="px-5 py-3 text-sm font-medium text-ink">{t(row.labelKey)}</td>
                    <td className="px-5 py-3">
                      <PermissionCell
                        row={editorRow}
                        roleId={3}
                        tenantId={matrix.tenantId}
                        isSuperAdmin={isSuperAdmin}
                        onChanged={handleCellChanged}
                      />
                    </td>
                    <td className="px-5 py-3">
                      <PermissionCell
                        row={viewerRow}
                        roleId={4}
                        tenantId={matrix.tenantId}
                        isSuperAdmin={isSuperAdmin}
                        onChanged={handleCellChanged}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </AppShell>
  );
}
