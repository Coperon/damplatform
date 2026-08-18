"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import Select from "@/components/Select";
import { EXIF_SOURCES } from "@/lib/exifSources";
import { useTranslation } from "@/lib/i18n";

type FieldType = "text" | "textarea" | "checkbox_group" | "tag" | "date";

// "" means no mapping (exif_source column is NULL) - kept as a plain string
// throughout so it drops straight into a native <select>'s value.
const NO_EXIF_SOURCE = "";
// "" in the Scope selector means "Global (all companies)" - tenant_id NULL.
const GLOBAL_SCOPE = "";

function exifSourcesFor(fieldType: FieldType) {
  return EXIF_SOURCES.filter((s) => s.appliesTo.includes(fieldType));
}

const FIELD_TYPE_LABEL_KEYS: Record<FieldType, string> = {
  text: "metadataFields.type.text",
  textarea: "metadataFields.type.textarea",
  checkbox_group: "metadataFields.type.checkboxGroup",
  tag: "metadataFields.type.tag",
  date: "metadataFields.type.date",
};

interface MetadataField {
  id: number;
  name: string;
  field_type: FieldType;
  searchable: boolean;
  sort_order: number;
  options: string[] | null;
  required: boolean;
  exif_source: string | null;
  // Tenant scoping (this stage): NULL = global (Coperon's, applies to every
  // tenant); set = that one tenant's own field. `tenant_name` is a join
  // done only by GET /api/metadata-fields (never present on a POST/PATCH
  // response), so state merges after a save/move always keep the previous
  // value rather than clobbering it with `undefined` - see handleSave/handleMove.
  tenant_id: string | null;
  tenant_name: string | null;
}

interface TenantOption {
  id: string;
  name: string;
}

// `options` is edited as a single comma-separated string (matches the
// checkbox-group option list), converted to/from the jsonb string array only
// at the API boundary (handleAdd / handleSave).
type PendingEdit = {
  name: string;
  field_type: FieldType;
  searchable: boolean;
  options: string;
  required: boolean;
  exifSource: string;
};

function optionsToText(options: string[] | null): string {
  return (options ?? []).join(", ");
}

function parseOptionsText(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}


function ArrowUpIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M10 15V5M5.5 9.5L10 5l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M10 5v10M5.5 10.5L10 15l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="5" y="9" width="10" height="7" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 016 0V9" strokeLinecap="round" />
    </svg>
  );
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{ backgroundColor: checked ? "var(--color-brand)" : "var(--color-input-border)" }}
      aria-pressed={checked}
    >
      <span
        className="inline-block h-3.5 w-3.5 transform rounded-full bg-card shadow transition-transform"
        style={{ transform: checked ? "translateX(18px)" : "translateX(3px)" }}
      />
    </button>
  );
}

export default function MetadataFieldsPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  const [isSuperAdminUser, setIsSuperAdminUser] = useState(false);

  const [fields, setFields] = useState<MetadataField[]>([]);
  const [companies, setCompanies] = useState<TenantOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pending, setPending] = useState<Record<number, PendingEdit>>({});
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [movingIds, setMovingIds] = useState<Set<number>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());

  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<FieldType>("text");
  const [newSearchable, setNewSearchable] = useState(true);
  const [newRequired, setNewRequired] = useState(false);
  const [newOptions, setNewOptions] = useState("");
  const [newExifSource, setNewExifSource] = useState(NO_EXIF_SOURCE);
  const [scopeTenantId, setScopeTenantId] = useState(GLOBAL_SCOPE);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  function authHeaders(): Record<string, string> {
    const token = localStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function seedPending(data: MetadataField[]) {
    const initial: Record<number, PendingEdit> = {};
    for (const f of data) {
      initial[f.id] = {
        name: f.name,
        field_type: f.field_type,
        searchable: f.searchable,
        options: optionsToText(f.options),
        required: f.required,
        exifSource: f.exif_source ?? NO_EXIF_SOURCE,
      };
    }
    setPending(initial);
  }

  async function loadFields() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/metadata-fields", { headers: authHeaders() });
      if (!res.ok) throw new Error(t("metadataFields.error.loadHttp", { status: res.status }));
      const data = (await res.json()) as MetadataField[];
      setFields(data);
      seedPending(data);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : t("metadataFields.error.loadGeneric"));
    } finally {
      setLoading(false);
    }
  }

  function loadCompanies() {
    fetch("/api/tenants", { headers: authHeaders() })
      .then((r) => (r.ok ? (r.json() as Promise<TenantOption[]>) : Promise.reject()))
      .then((data) => setCompanies(data))
      .catch(() => setCompanies([]));
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    const payload = parseToken(token);
    // Tenant-scoped metadata fields (this stage): a tenant admin manages
    // their own tenant's fields (plus a read-only view of Coperon's global
    // ones); a super admin manages every tenant's. Both carry canAdmin,
    // so this page is now reachable by either tier - editors/viewers (no
    // canAdmin) are still turned away below.
    if (!payload?.canAdmin) {
      setNotAdmin(true);
      setAuthorized(true);
      return;
    }
    setIsSuperAdminUser(payload?.roleName === "super_admin");
    setAuthorized(true);
    loadFields();
    if (payload?.roleName === "super_admin") loadCompanies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  function isDirty(f: MetadataField): boolean {
    const p = pending[f.id];
    if (!p) return false;
    return (
      p.name !== f.name ||
      p.field_type !== f.field_type ||
      p.searchable !== f.searchable ||
      p.required !== f.required ||
      p.options !== optionsToText(f.options) ||
      p.exifSource !== (f.exif_source ?? NO_EXIF_SOURCE)
    );
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      setAddError(t("metadataFields.add.nameRequired"));
      return;
    }
    const parsedOptions = parseOptionsText(newOptions);
    if (newType === "checkbox_group" && parsedOptions.length === 0) {
      setAddError(t("metadataFields.add.optionsRequired"));
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch("/api/metadata-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name,
          fieldType: newType,
          searchable: newSearchable,
          required: newRequired,
          ...(newType === "checkbox_group" ? { options: parsedOptions } : {}),
          exifSource: newExifSource || null,
          // Only a super admin's choice is ever sent - a tenant admin has
          // no Scope control at all (their field is always their own
          // tenant, forced server-side from the token regardless of what,
          // if anything, were sent here).
          ...(isSuperAdminUser ? { tenantId: scopeTenantId || null } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      const created = body as MetadataField;

      // New fields default to sort_order 0 server-side; push them to the end
      // of their own scope's current order (global, or that one tenant's),
      // not the end of the combined cross-scope list.
      const scopeCount = fields.filter((f) => f.tenant_id === created.tenant_id).length;
      if (scopeCount > 0) {
        await fetch(`/api/metadata-fields/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ sortOrder: scopeCount }),
        });
      }

      // Refetch rather than splice locally: the POST response has no
      // `tenant_name` join (that's GET-only), and a full reload keeps
      // ordering canonical with zero risk of drifting from the server.
      await loadFields();
      setNewName("");
      setNewType("text");
      setNewSearchable(true);
      setNewRequired(false);
      setNewOptions("");
      setNewExifSource(NO_EXIF_SOURCE);
      setScopeTenantId(GLOBAL_SCOPE);
    } catch {
      setAddError(t("common.error.couldNotReachServer"));
    } finally {
      setAdding(false);
    }
  }

  async function handleSave(field: MetadataField) {
    const edit = pending[field.id];
    if (!edit) return;

    setSavingIds((prev) => new Set(prev).add(field.id));
    setRowErrors((prev) => { const n = { ...prev }; delete n[field.id]; return n; });
    setSavedIds((prev) => { const n = new Set(prev); n.delete(field.id); return n; });

    const body: Record<string, unknown> = {};
    if (edit.name !== field.name) body.name = edit.name;
    if (edit.field_type !== field.field_type) body.fieldType = edit.field_type;
    if (edit.searchable !== field.searchable) body.searchable = edit.searchable;
    if (edit.required !== field.required) body.required = edit.required;
    if (edit.field_type === "checkbox_group" && edit.options !== optionsToText(field.options)) {
      body.options = parseOptionsText(edit.options);
    }
    if (edit.exifSource !== (field.exif_source ?? NO_EXIF_SOURCE)) {
      body.exifSource = edit.exifSource || null;
    }

    try {
      const res = await fetch(`/api/metadata-fields/${field.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowErrors((prev) => ({ ...prev, [field.id]: (resBody as { error?: string }).error ?? t("common.error.generic", { status: res.status }) }));
        return;
      }
      // PATCH's response has no `tenant_name` join - keep the row's
      // existing value rather than losing it to an absent key.
      const updated: MetadataField = { ...field, ...(resBody as Partial<MetadataField>) };
      setFields((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      setPending((prev) => ({
        ...prev,
        [updated.id]: {
          name: updated.name,
          field_type: updated.field_type,
          searchable: updated.searchable,
          options: optionsToText(updated.options),
          required: updated.required,
          exifSource: updated.exif_source ?? NO_EXIF_SOURCE,
        },
      }));
      setSavedIds((prev) => new Set(prev).add(field.id));
      setTimeout(() => {
        setSavedIds((prev) => { const n = new Set(prev); n.delete(field.id); return n; });
      }, 2000);
    } catch {
      setRowErrors((prev) => ({ ...prev, [field.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setSavingIds((prev) => { const n = new Set(prev); n.delete(field.id); return n; });
    }
  }

  // `subset` is one scope's own ordered slice (global, or one tenant's) -
  // sort_order is meaningful only within a scope, so reordering never
  // crosses a scope boundary and every PATCHed sortOrder is just the row's
  // new position inside this one subset, not a global index.
  async function handleMove(subset: MetadataField[], index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= subset.length) return;

    const reordered = [...subset];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

    const movedIds = new Set([subset[index].id, subset[target].id]);
    setMovingIds((prev) => new Set([...prev, ...movedIds]));

    try {
      const updates: Partial<MetadataField>[] = [];
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].sort_order === i) continue;
        const res = await fetch(`/api/metadata-fields/${reordered[i].id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ sortOrder: i }),
        });
        if (res.ok) updates.push(await res.json());
      }
      setFields((prev) => {
        const byId = new Map(prev.map((f) => [f.id, f]));
        for (const u of updates) {
          if (typeof u.id !== "number") continue;
          const existing = byId.get(u.id);
          if (existing) byId.set(u.id, { ...existing, ...u });
        }
        return Array.from(byId.values());
      });
    } finally {
      setMovingIds((prev) => { const n = new Set(prev); for (const id of movedIds) n.delete(id); return n; });
    }
  }

  async function handleDelete(field: MetadataField) {
    const ok = window.confirm(
      field.tenant_id === null
        ? t("metadataFields.delete.confirmGlobal", { name: field.name })
        : t("metadataFields.delete.confirmTenant", { name: field.name }),
    );
    if (!ok) return;

    setDeletingIds((prev) => new Set(prev).add(field.id));
    try {
      const res = await fetch(`/api/metadata-fields/${field.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowErrors((prev) => ({ ...prev, [field.id]: (body as { error?: string }).error ?? t("common.error.generic", { status: res.status }) }));
        return;
      }
      setFields((prev) => prev.filter((f) => f.id !== field.id));
      setPending((prev) => { const n = { ...prev }; delete n[field.id]; return n; });
    } catch {
      setRowErrors((prev) => ({ ...prev, [field.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setDeletingIds((prev) => { const n = new Set(prev); n.delete(field.id); return n; });
    }
  }

  if (!authorized) return null;

  if (notAdmin) {
    return (
      <AppShell active="metadata-fields" title={t("metadataFields.pageTitle")}>
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

  // Global fields first (by sort_order), then every tenant's fields grouped
  // by tenant (each by sort_order) - same ordering convention as every
  // field-read site touched this stage, kept here purely for display.
  const sorted = [...fields].sort((a, b) => {
    const aGlobal = a.tenant_id === null ? 0 : 1;
    const bGlobal = b.tenant_id === null ? 0 : 1;
    if (aGlobal !== bGlobal) return aGlobal - bGlobal;
    if ((a.tenant_id ?? "") !== (b.tenant_id ?? "")) return (a.tenant_id ?? "").localeCompare(b.tenant_id ?? "");
    return a.sort_order - b.sort_order || a.id - b.id;
  });
  const globalFields = sorted.filter((f) => f.tenant_id === null);
  const tenantFields = sorted.filter((f) => f.tenant_id !== null);

  // Preserve first-seen order (already grouped by the sort above) rather
  // than re-sorting by name, so a super admin's panels land in a stable,
  // predictable order across reloads.
  const tenantGroups: { tenantId: string; tenantName: string; fields: MetadataField[] }[] = [];
  for (const f of tenantFields) {
    const last = tenantGroups[tenantGroups.length - 1];
    if (last && last.tenantId === f.tenant_id) {
      last.fields.push(f);
    } else {
      tenantGroups.push({ tenantId: f.tenant_id!, tenantName: f.tenant_name ?? t("metadataFields.section.unknownCompany"), fields: [f] });
    }
  }

  function renderEditableTable(subset: MetadataField[]) {
    return (
      <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
        <table className="min-w-full">
          <thead>
            <tr className="border-b border-line/70">
              <th className="w-16 px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("metadataFields.table.headerOrder")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.name")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.type")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("metadataFields.table.headerAutoFill")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("metadataFields.table.headerSearchable")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("metadataFields.table.headerRequired")}</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {subset.map((f, index) => {
              const edit = pending[f.id] ?? {
                name: f.name,
                field_type: f.field_type,
                searchable: f.searchable,
                options: optionsToText(f.options),
                required: f.required,
                exifSource: f.exif_source ?? NO_EXIF_SOURCE,
              };
              const dirty = isDirty(f);
              const saving = savingIds.has(f.id);
              const saved = savedIds.has(f.id);
              const moving = movingIds.has(f.id);
              const deleting = deletingIds.has(f.id);
              const error = rowErrors[f.id];

              return (
                <tr
                  key={f.id}
                  className={`border-b border-surface-tint-2 last:border-b-0 transition-colors ${
                    dirty ? "bg-surface-tint/50" : "hover:bg-white/40 dark:hover:bg-white/5"
                  }`}
                >
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => handleMove(subset, index, -1)}
                        disabled={index === 0 || moving}
                        className="flex h-5 w-5 cursor-pointer items-center justify-center text-slate transition-colors hover:text-brand disabled:cursor-not-allowed disabled:opacity-30"
                        title={t("metadataFields.aria.moveUp")}
                      >
                        <ArrowUpIcon />
                      </button>
                      <button
                        onClick={() => handleMove(subset, index, 1)}
                        disabled={index === subset.length - 1 || moving}
                        className="flex h-5 w-5 cursor-pointer items-center justify-center text-slate transition-colors hover:text-brand disabled:cursor-not-allowed disabled:opacity-30"
                        title={t("metadataFields.aria.moveDown")}
                      >
                        <ArrowDownIcon />
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <input
                      value={edit.name}
                      disabled={saving}
                      onChange={(e) =>
                        setPending((prev) => ({ ...prev, [f.id]: { ...edit, name: e.target.value } }))
                      }
                      maxLength={100}
                      className={`rounded-[8px] border bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 ${
                        dirty ? "border-brand ring-[3px] ring-brand/15" : "border-line focus:border-brand focus:ring-brand/15"
                      }`}
                    />
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-1.5">
                      <Select
                        ariaLabel={t("metadataFields.aria.fieldTypeFor", { name: edit.name })}
                        value={edit.field_type}
                        disabled={saving}
                        onChange={(v) => {
                          const nextType = v as FieldType;
                          const stillApplies = exifSourcesFor(nextType).some((s) => s.value === edit.exifSource);
                          setPending((prev) => ({
                            ...prev,
                            [f.id]: {
                              ...edit,
                              field_type: nextType,
                              exifSource: stillApplies ? edit.exifSource : NO_EXIF_SOURCE,
                            },
                          }));
                        }}
                        options={(Object.entries(FIELD_TYPE_LABEL_KEYS) as [FieldType, string][]).map(([value, labelKey]) => ({
                          value,
                          label: t(labelKey),
                        }))}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 ${
                          dirty ? "border-brand ring-[3px] ring-brand/15" : "border-line focus:border-brand focus:ring-brand/15"
                        }`}
                      />
                      {edit.field_type === "checkbox_group" && (
                        <input
                          value={edit.options}
                          disabled={saving}
                          onChange={(e) =>
                            setPending((prev) => ({ ...prev, [f.id]: { ...edit, options: e.target.value } }))
                          }
                          placeholder={t("metadataFields.field.optionsPlaceholder")}
                          className="w-52 rounded-[6px] border border-line bg-card px-2 py-1 text-xs text-ink outline-none focus:border-brand focus:ring-[2px] focus:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <Select
                      ariaLabel={t("metadataFields.aria.autoFillFor", { name: edit.name })}
                      value={edit.exifSource}
                      disabled={saving}
                      onChange={(v) => setPending((prev) => ({ ...prev, [f.id]: { ...edit, exifSource: v } }))}
                      options={[
                        { value: NO_EXIF_SOURCE, label: t("common.none") },
                        ...exifSourcesFor(edit.field_type).map((s) => ({ value: s.value, label: s.label })),
                      ]}
                      className={`flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 ${
                        dirty ? "border-brand ring-[3px] ring-brand/15" : "border-line focus:border-brand focus:ring-brand/15"
                      }`}
                    />
                  </td>
                  <td className="px-5 py-3">
                    <Toggle
                      checked={edit.searchable}
                      disabled={saving}
                      onChange={(v) => setPending((prev) => ({ ...prev, [f.id]: { ...edit, searchable: v } }))}
                    />
                  </td>
                  <td className="px-5 py-3">
                    <Toggle
                      checked={edit.required}
                      disabled={saving}
                      onChange={(v) => setPending((prev) => ({ ...prev, [f.id]: { ...edit, required: v } }))}
                    />
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
                      {saved && <span className="text-xs text-green-600 dark:text-green-400">{t("common.saved")}</span>}
                      <button
                        onClick={() => handleSave(f)}
                        disabled={saving || !dirty}
                        className={`cursor-pointer rounded-[8px] px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                          dirty
                            ? "bg-brand text-white shadow-[0_4px_12px_var(--shadow-color-brand)] hover:bg-brand-hover disabled:opacity-60"
                            : "border border-line bg-white/60 dark:bg-white/10 text-slate disabled:opacity-60"
                        }`}
                      >
                        {saving ? t("common.saving") : t("common.save")}
                      </button>
                      <button
                        onClick={() => handleDelete(f)}
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
        {subset.length === 0 && (
          <p className="px-5 py-6 text-sm text-slate">{t("metadataFields.table.empty")}</p>
        )}
      </div>
    );
  }

  // Read-only view of Coperon's global fields, for a tenant admin who
  // cannot edit or delete them - no Order/Actions column at all, since
  // there is nothing here for this viewer to do.
  function renderReadOnlyGlobalTable(subset: MetadataField[]) {
    return (
      <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
        <table className="min-w-full">
          <thead>
            <tr className="border-b border-line/70">
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.name")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("common.type")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("metadataFields.table.headerAutoFill")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("metadataFields.table.headerSearchable")}</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">{t("metadataFields.table.headerRequired")}</th>
            </tr>
          </thead>
          <tbody>
            {subset.map((f) => (
              <tr key={f.id} className="border-b border-surface-tint-2 last:border-b-0">
                <td className="px-5 py-3 text-sm text-ink">{f.name}</td>
                <td className="px-5 py-3 text-sm text-slate">{t(FIELD_TYPE_LABEL_KEYS[f.field_type])}</td>
                <td className="px-5 py-3 text-sm text-slate">
                  {EXIF_SOURCES.find((s) => s.value === f.exif_source)?.label ?? t("common.none")}
                </td>
                <td className="px-5 py-3"><Toggle checked={f.searchable} disabled onChange={() => {}} /></td>
                <td className="px-5 py-3"><Toggle checked={f.required} disabled onChange={() => {}} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {subset.length === 0 && (
          <p className="px-5 py-6 text-sm text-slate">{t("metadataFields.table.emptyGlobal")}</p>
        )}
      </div>
    );
  }

  const countPill =
    !loading && !loadError ? (
      <span className="dam-glass inline-flex h-9 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium text-ink">
        {t("metadataFields.count", { count: fields.length })}
      </span>
    ) : undefined;

  return (
    <AppShell active="metadata-fields" title={t("metadataFields.pageTitle")} actions={countPill}>
      {/* Add field */}
      <form
        onSubmit={handleAdd}
        className="dam-glass mb-6 flex flex-wrap items-end gap-3 rounded-[14px] p-4 shadow-[0_8px_24px_rgba(0,46,92,0.10)]"
      >
        <div className="flex min-w-[200px] flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-slate">{t("metadataFields.add.nameLabel")}</label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("metadataFields.add.namePlaceholder")}
            maxLength={100}
            className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate">{t("common.type")}</label>
          <Select
            ariaLabel={t("metadataFields.aria.fieldType")}
            value={newType}
            onChange={(v) => {
              const nextType = v as FieldType;
              setNewType(nextType);
              if (!exifSourcesFor(nextType).some((s) => s.value === newExifSource)) {
                setNewExifSource(NO_EXIF_SOURCE);
              }
            }}
            options={(Object.entries(FIELD_TYPE_LABEL_KEYS) as [FieldType, string][]).map(([value, labelKey]) => ({
              value,
              label: t(labelKey),
            }))}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
          />
        </div>

        {isSuperAdminUser && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate">{t("metadataFields.add.scopeLabel")}</label>
            <Select
              ariaLabel={t("metadataFields.add.scopeLabel")}
              value={scopeTenantId}
              onChange={setScopeTenantId}
              options={[
                { value: GLOBAL_SCOPE, label: t("metadataFields.add.globalScopeOption") },
                ...companies.map((c) => ({ value: c.id, label: c.name })),
              ]}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate">{t("metadataFields.table.headerAutoFill")}</label>
          <Select
            ariaLabel={t("metadataFields.table.headerAutoFill")}
            value={newExifSource}
            onChange={setNewExifSource}
            options={[
              { value: NO_EXIF_SOURCE, label: t("common.none") },
              ...exifSourcesFor(newType).map((s) => ({ value: s.value, label: s.label })),
            ]}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card py-1.5 px-3 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
          />
        </div>

        {newType === "checkbox_group" && (
          <div className="flex min-w-[240px] flex-1 flex-col gap-1">
            <label className="text-xs font-medium text-slate">{t("metadataFields.add.optionsLabel")}</label>
            <input
              value={newOptions}
              onChange={(e) => setNewOptions(e.target.value)}
              placeholder={t("metadataFields.add.optionsExamplePlaceholder")}
              className="rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate">{t("metadataFields.table.headerSearchable")}</label>
          <div className="flex h-[34px] items-center">
            <Toggle checked={newSearchable} onChange={setNewSearchable} />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate">{t("metadataFields.table.headerRequired")}</label>
          <div className="flex h-[34px] items-center">
            <Toggle checked={newRequired} onChange={setNewRequired} />
          </div>
        </div>

        <button
          type="submit"
          disabled={adding}
          className="cursor-pointer rounded-[8px] bg-brand px-4 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {adding ? t("metadataFields.add.adding") : t("metadataFields.add.submit")}
        </button>

        {!isSuperAdminUser && (
          <p className="w-full text-xs text-slate">
            {t("metadataFields.add.tenantHint")}
          </p>
        )}

        {addError && <p className="w-full text-xs text-red-600 dark:text-red-400">{addError}</p>}
      </form>

      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && (
        <div className="flex flex-col gap-8">
          {isSuperAdminUser ? (
            <>
              <section>
                <h2 className="mb-2 text-sm font-semibold text-ink">{t("metadataFields.section.globalFields")}</h2>
                <p className="mb-3 text-xs text-slate">{t("metadataFields.section.globalFieldsHint")}</p>
                {renderEditableTable(globalFields)}
              </section>
              {tenantGroups.map((group) => (
                <section key={group.tenantId}>
                  <h2 className="mb-2 text-sm font-semibold text-ink">{group.tenantName}</h2>
                  <p className="mb-3 text-xs text-slate">{t("metadataFields.section.tenantFieldsHint")}</p>
                  {renderEditableTable(group.fields)}
                </section>
              ))}
              {tenantGroups.length === 0 && (
                <p className="text-sm text-slate">{t("metadataFields.section.noTenantFields")}</p>
              )}
            </>
          ) : (
            <>
              <section>
                <h2 className="mb-2 text-sm font-semibold text-ink">{t("metadataFields.section.yourFields")}</h2>
                {renderEditableTable(tenantFields)}
              </section>
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">{t("metadataFields.section.globalFields")}</h2>
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-tint px-2.5 py-0.5 text-[11px] font-medium text-slate">
                    <LockIcon /> {t("metadataFields.section.globalBadge")}
                  </span>
                </div>
                <p className="mb-3 text-xs text-slate">
                  {t("metadataFields.section.globalReadOnlyHint")}
                </p>
                {renderReadOnlyGlobalTable(globalFields)}
              </section>
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}
