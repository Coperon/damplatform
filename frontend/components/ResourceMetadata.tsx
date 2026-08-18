"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";

type FieldType = "text" | "textarea" | "checkbox_group" | "tag" | "date";

interface MetadataValue {
  fieldId: number;
  name: string;
  fieldType: FieldType;
  searchable: boolean;
  sortOrder: number;
  options: string[] | null;
  required: boolean;
  value: string | null;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// checkbox_group and tag values still serialize to the single `value` text
// column as a ", "-joined string (see the encoding-convention comment in
// app/api/resources/[id]/metadata/route.ts) — these two helpers are the only
// place that string gets parsed into/out of a list for editing and display.
function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function joinList(values: string[]): string {
  return values.join(", ");
}

// "Empty" per type, for required-field validation: text/textarea/date are
// blank/whitespace; checkbox_group/tag are empty when nothing is selected.
function isValueEmpty(fieldType: FieldType, value: string): boolean {
  if (fieldType === "checkbox_group" || fieldType === "tag") {
    return parseList(value).length === 0;
  }
  return !value.trim();
}

function ChipList({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <span className="italic text-border-soft">—</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center rounded-full bg-surface-tint px-2 py-0.5 text-[11px] font-medium text-brand"
        >
          {v}
        </span>
      ))}
    </span>
  );
}

// One field's edit control — text/textarea/date are plain inputs; checkbox_group
// renders its fixed option list as checkboxes; tag is a free-type chip input.
// All of them read/write the same `draft[fieldId]` string via join/parseList.
function FieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: MetadataValue;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const [tagInput, setTagInput] = useState("");

  if (field.fieldType === "textarea") {
    return (
      <textarea
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        maxLength={5000}
        rows={2}
        className="w-full resize-none rounded-[6px] border border-line px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-50"
      />
    );
  }

  if (field.fieldType === "date") {
    return (
      <input
        type="date"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[6px] border border-line px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-50"
      />
    );
  }

  if (field.fieldType === "checkbox_group") {
    const selected = new Set(parseList(value));
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {(field.options ?? []).map((opt) => (
          <label key={opt} className="flex items-center gap-1.5 text-xs text-ink">
            <input
              type="checkbox"
              checked={selected.has(opt)}
              disabled={disabled}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(opt);
                else next.delete(opt);
                onChange(joinList(Array.from(next)));
              }}
            />
            {opt}
          </label>
        ))}
      </div>
    );
  }

  if (field.fieldType === "tag") {
    const chips = parseList(value);

    function commitTagInput() {
      const v = tagInput.trim();
      setTagInput("");
      if (!v || chips.includes(v)) return;
      onChange(joinList([...chips, v]));
    }

    return (
      <div className="flex flex-wrap items-center gap-1.5 rounded-[6px] border border-line p-1.5">
        {chips.map((c) => (
          <span
            key={c}
            className="inline-flex items-center gap-1 rounded-full bg-surface-tint px-2 py-0.5 text-[11px] font-medium text-brand"
          >
            {c}
            <button
              type="button"
              onClick={() => onChange(joinList(chips.filter((v) => v !== c)))}
              disabled={disabled}
              className="cursor-pointer text-brand hover:text-brand-hover disabled:opacity-50"
              aria-label={t("resourceMetadata.tag.remove", { name: c })}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={tagInput}
          disabled={disabled}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commitTagInput();
            } else if (e.key === "Backspace" && !tagInput && chips.length > 0) {
              onChange(joinList(chips.slice(0, -1)));
            }
          }}
          onBlur={commitTagInput}
          placeholder={t("resourceMetadata.tag.placeholder")}
          className="min-w-[100px] flex-1 border-none py-0.5 text-xs text-ink outline-none disabled:opacity-50"
        />
      </div>
    );
  }

  // text
  return (
    <input
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      maxLength={5000}
      className="w-full rounded-[6px] border border-line px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-50"
    />
  );
}

// Read-only display for one field — used both in the admin's collapsed
// (click-to-edit) view and the client's read-only view.
function FieldDisplay({ field }: { field: MetadataValue }) {
  if (field.fieldType === "checkbox_group" || field.fieldType === "tag") {
    return <ChipList values={parseList(field.value)} />;
  }
  return field.value ? (
    <span className="text-slate hover:text-ink">{field.value}</span>
  ) : (
    <span className="italic text-border-soft hover:text-slate">—</span>
  );
}

// Imperative handle exposed via ref — additive, opt-in. Only the full-page
// workflow editor uses this (to drive Save from its own "Save and next"
// button); the drawer and standalone-kebab usages never pass a ref.
export interface ResourceMetadataHandle {
  save: () => Promise<boolean>;
}

// Displays (all roles) and edits (admins, or an editor whose group can reach
// this resource — the caller resolves that and passes canEdit; the API's own
// canEditResourceMetadata check, lib/permissions.ts, is the real boundary) a
// resource's custom metadata field values. Self-contained: fetches its own
// data per-resource on mount (there's no card detail/expander to fetch
// alongside), so it drops into the existing file card next to the
// description block with no change to the surrounding card fetch/state logic.
const ResourceMetadata = forwardRef<
  ResourceMetadataHandle,
  {
    resourceId: string;
    canEdit: boolean;
    // Additive, opt-in: when true (and canEdit), the component opens directly
    // into the edit form the first time fields load, instead of the collapsed
    // click-to-edit summary. Used by the full-page metadata editor so it reads
    // as a ready-to-fill form; the drawer omits this prop and keeps its
    // original click-to-edit behavior unchanged.
    autoEdit?: boolean;
    // Additive, opt-in: when true, the internal Save/Cancel footer is not
    // rendered — the caller drives saving itself via the imperative `ref`.
    // Used by the full-page workflow editor, which has its own Save-and-next
    // action bar; every other usage omits this and keeps the built-in footer.
    hideActions?: boolean;
    // Additive, opt-in: when true, save() rejects (returns false, without
    // persisting) if any `required` field is empty, surfacing an inline error
    // per field instead. Required is a submission-gate rule for the upload
    // workflow only — the drawer and standalone editor omit this prop and
    // save freely even with empty required fields, matching the existing
    // "casual edits shouldn't trap you" behavior.
    enforceRequired?: boolean;
  }
>(function ResourceMetadata(
  { resourceId, canEdit, autoEdit = false, hideActions = false, enforceRequired = false },
  ref,
) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<MetadataValue[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});
  const autoEditTriggeredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/resources/${resourceId}/metadata`, { headers: authHeaders() })
      .then((r) => (r.ok ? (r.json() as Promise<MetadataValue[]>) : Promise.reject()))
      .then((data) => {
        if (!cancelled) setFields(data);
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  useEffect(() => {
    if (autoEdit && canEdit && fields && fields.length > 0 && !autoEditTriggeredRef.current) {
      autoEditTriggeredRef.current = true;
      startEdit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, autoEdit, canEdit]);

  // Declared before the early-return below so the hook is always called on
  // every render, regardless of whether `fields` has loaded yet (function
  // declarations are hoisted, so `handleSave` itself is already defined here).
  useImperativeHandle(ref, () => ({ save: handleSave }));

  if (fields === null || fields.length === 0) return null;

  function startEdit() {
    const initial: Record<number, string> = {};
    for (const f of fields!) initial[f.fieldId] = f.value ?? "";
    setDraft(initial);
    setError(null);
    setFieldErrors({});
    setEditing(true);
  }

  async function handleSave(): Promise<boolean> {
    if (enforceRequired) {
      const missing: Record<number, string> = {};
      for (const f of fields!) {
        if (!f.required) continue;
        if (isValueEmpty(f.fieldType, draft[f.fieldId] ?? "")) {
          missing[f.fieldId] = t("resourceMetadata.field.required");
        }
      }
      if (Object.keys(missing).length > 0) {
        setFieldErrors(missing);
        return false;
      }
    }
    setFieldErrors({});
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/resources/${resourceId}/metadata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          values: Object.entries(draft).map(([fieldId, value]) => ({
            fieldId: Number(fieldId),
            value,
          })),
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const updated = (await res.json()) as MetadataValue[];
      setFields(updated);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    } catch {
      setError(t("resourceMetadata.error.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (canEdit && editing) {
    return (
      <div className="mt-2 flex flex-col gap-2 rounded-[8px] border border-line bg-white/60 dark:bg-white/10 p-2">
        {fields.map((f) => (
          <div key={f.fieldId} className="flex flex-col gap-0.5">
            <label className="text-[10px] font-medium uppercase tracking-wide text-slate">
              {f.name}
              {f.required && <span className="ml-0.5 text-red-500 dark:text-red-400">*</span>}
            </label>
            <FieldEditor
              field={f}
              value={draft[f.fieldId] ?? ""}
              disabled={saving}
              onChange={(next) => {
                setDraft((prev) => ({ ...prev, [f.fieldId]: next }));
                if (fieldErrors[f.fieldId]) {
                  setFieldErrors((prev) => {
                    const n = { ...prev };
                    delete n[f.fieldId];
                    return n;
                  });
                }
              }}
            />
            {fieldErrors[f.fieldId] && (
              <p className="text-[10px] text-red-500 dark:text-red-400">{fieldErrors[f.fieldId]}</p>
            )}
          </div>
        ))}
        {!hideActions && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="cursor-pointer rounded-[6px] bg-brand px-2 py-0.5 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
            <button
              onClick={() => { setEditing(false); setError(null); }}
              disabled={saving}
              className="cursor-pointer rounded-[6px] border border-line px-2 py-0.5 text-xs text-slate hover:bg-mist disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
          </div>
        )}
        {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  if (canEdit) {
    return (
      <button onClick={startEdit} className="mt-2 w-full cursor-pointer text-left">
        <div className="flex flex-col gap-0.5">
          {fields.map((f) => (
            <p key={f.fieldId} className="text-xs leading-relaxed">
              <span className="font-medium text-ink">{f.name}: </span>
              <FieldDisplay field={f} />
            </p>
          ))}
        </div>
        {saved && <p className="mt-1 text-xs text-green-600 dark:text-green-400">{t("common.saved")}</p>}
      </button>
    );
  }

  // Clients: read-only, and only ever show fields that actually have a value.
  const visible = fields.filter((f) => f.value && f.value.trim());
  if (visible.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {visible.map((f) => (
        <p key={f.fieldId} className="text-xs leading-relaxed text-slate">
          <span className="font-medium text-ink">{f.name}: </span>
          <FieldDisplay field={f} />
        </p>
      ))}
    </div>
  );
});

export default ResourceMetadata;
