"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// One reusable expand/collapse collection picker, replacing every flat
// em-dash-indented <select> in the app. Lazily fetches one tree level at a
// time (GET /api/collections, optionally ?parentId=<id>) and caches each
// level per node so re-expanding never refetches. Rendered through a portal
// to document.body: several call sites live inside a `.dam-glass` ancestor,
// and `backdrop-filter` establishes a new containing block for descendant
// `position: fixed` elements in modern browsers — without the portal the
// panel would be positioned relative to that ancestor instead of the
// viewport, and could be clipped by any `overflow-hidden` on the way up
// (the same stacking/overflow gotcha recorded elsewhere in this app).
const NONE_ID = "__none__";

interface CollectionNode {
  id: string;
  name: string;
  subcollection_count: number;
}

type LevelState = CollectionNode[] | "loading" | "error";

interface FlatEntry {
  id: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  disabled: boolean;
  loadingChildren: boolean;
  loadErrored: boolean;
}

export interface CollectionTreePickerProps {
  value: string | null;
  onChange: (id: string | null) => void;
  /** When true, picking a node commits immediately and the trigger never shows
   * a persisted "selected" chip — used by the two assign/mutate sites, where
   * `value` stays `null` and each pick is a one-shot action. When false (the
   * default), this is a normal controlled value/onChange picker. */
  commitOnSelect?: boolean;
  /** Renders a top "All collections" (or custom label) row that resolves to `value: null`. */
  allowNone?: boolean;
  rootLabel?: string;
  /** Node ids to render disabled (muted, unselectable, still expandable) — e.g. collections a file already belongs to. */
  excludeIds?: string[];
  /** Disables this node and every descendant (a whole branch) — for a future move/set-parent picker; no current site uses it. */
  excludeSubtreeOf?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchLevel(parentId: string | null): Promise<CollectionNode[]> {
  const url = parentId ? `/api/collections?parentId=${encodeURIComponent(parentId)}` : "/api/collections";
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load collections (${res.status})`);
  return (await res.json()) as CollectionNode[];
}

function ChevronToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-3 w-3 shrink-0 text-slate transition-transform ${expanded ? "rotate-90" : ""}`}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M7 4.5l6 5.5-6 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TriggerChevronIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-slate" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M5.5 8l4.5 4.5L14.5 8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 shrink-0 animate-spin text-slate" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M17.5 10a7.5 7.5 0 00-7.5-7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function CollectionTreePicker({
  value,
  onChange,
  commitOnSelect = false,
  allowNone = false,
  rootLabel,
  excludeIds,
  excludeSubtreeOf,
  disabled = false,
  placeholder,
  className,
}: CollectionTreePickerProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const [cache, setCache] = useState<Record<string, LevelState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [nameCache, setNameCache] = useState<Record<string, string>>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<Record<string, LevelState>>({});
  cacheRef.current = cache;

  function setLevel(key: string, level: LevelState) {
    setCache((prev) => ({ ...prev, [key]: level }));
  }

  async function ensureChildren(key: string, parentId: string | null) {
    if (cacheRef.current[key] !== undefined) return; // cached (array/loading/error) — never refetch
    setLevel(key, "loading");
    try {
      const data = await fetchLevel(parentId);
      setLevel(key, data);
      setNameCache((prev) => {
        const next = { ...prev };
        for (const n of data) next[n.id] = n.name;
        return next;
      });
    } catch {
      setLevel(key, "error");
    }
  }

  function retry(key: string, parentId: string | null) {
    setCache((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    cacheRef.current = { ...cacheRef.current };
    delete cacheRef.current[key];
    ensureChildren(key, parentId);
  }

  // Resolve a display name for a `value` set from outside the tree the user
  // has actually browsed (e.g. a pre-selected id on mount) — falls back to
  // GET /api/collections/[id] rather than requiring the whole tree be walked.
  useEffect(() => {
    if (!value || nameCache[value]) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/collections/${value}`, { headers: authHeaders() });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { name: string };
        if (!cancelled) setNameCache((prev) => (prev[value] ? prev : { ...prev, [value]: data.name }));
      } catch {
        // leave unresolved — trigger shows a generic fallback below
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (open) ensureChildren("root", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) treeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  function openPanel() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(rect.width, 260);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      const panelHeight = 320;
      const opensDown = rect.bottom + 6 + panelHeight <= window.innerHeight;
      setPos(
        opensDown
          ? { top: rect.bottom + 6, left, width }
          : { bottom: window.innerHeight - rect.top + 6, left, width },
      );
    }
    setOpen(true);
  }

  function toggleExpand(entry: FlatEntry) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      return next;
    });
    if (!expanded.has(entry.id)) ensureChildren(entry.id, entry.id);
  }

  function selectNode(id: string | null, isDisabled: boolean) {
    if (isDisabled) return;
    onChange(id);
    setOpen(false);
  }

  // Flattens the currently-visible (i.e. every ancestor already expanded)
  // portion of the tree into an ordered list — used both to render rows and
  // to drive arrow-key navigation, so the two never disagree on order.
  function buildEntries(): FlatEntry[] {
    const out: FlatEntry[] = [];
    if (allowNone) {
      out.push({
        id: NONE_ID,
        name: rootLabel ?? "All collections",
        depth: 0,
        hasChildren: false,
        expanded: false,
        disabled: false,
        loadingChildren: false,
        loadErrored: false,
      });
    }
    function walk(key: string, depth: number, subtreeExcluded: boolean) {
      const level = cache[key];
      if (!Array.isArray(level)) return;
      for (const node of level) {
        const nodeSubtreeExcluded = subtreeExcluded || node.id === excludeSubtreeOf;
        const isExpanded = expanded.has(node.id);
        const childLevel = cache[node.id];
        out.push({
          id: node.id,
          name: node.name,
          depth,
          hasChildren: node.subcollection_count > 0,
          expanded: isExpanded,
          disabled: nodeSubtreeExcluded || (excludeIds?.includes(node.id) ?? false),
          loadingChildren: isExpanded && childLevel === "loading",
          loadErrored: isExpanded && childLevel === "error",
        });
        if (isExpanded && Array.isArray(childLevel)) {
          walk(node.id, depth + 1, nodeSubtreeExcluded);
        }
      }
    }
    walk("root", 0, false);
    return out;
  }

  const entries = open ? buildEntries() : [];
  const rootLevel = cache.root;

  useEffect(() => {
    if (!open) return;
    if (!activeId || !entries.some((e) => e.id === activeId)) {
      setActiveId(entries[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entries]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (entries.length === 0) return;
    const idx = entries.findIndex((en) => en.id === activeId);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveId(entries[Math.min(entries.length - 1, idx + 1)]?.id ?? entries[0].id);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveId(entries[Math.max(0, idx - 1)]?.id ?? entries[0].id);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const entry = entries[idx];
      if (!entry || entry.id === NONE_ID) return;
      if (entry.hasChildren && !entry.expanded) {
        setExpanded((prev) => new Set(prev).add(entry.id));
        ensureChildren(entry.id, entry.id);
      } else if (entry.expanded) {
        const child = entries[idx + 1];
        if (child && child.depth > entry.depth) setActiveId(child.id);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const entry = entries[idx];
      if (!entry || entry.id === NONE_ID) return;
      if (entry.expanded) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
      } else {
        for (let i = idx - 1; i >= 0; i--) {
          if (entries[i].depth < entry.depth) {
            setActiveId(entries[i].id);
            break;
          }
        }
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[idx];
      if (!entry) return;
      selectNode(entry.id === NONE_ID ? null : entry.id, entry.disabled);
    }
  }

  const triggerLabel = commitOnSelect
    ? (placeholder ?? "Add to collection…")
    : value == null
      ? (allowNone ? (rootLabel ?? "All collections") : (placeholder ?? "Select a collection…"))
      : (nameCache[value] ?? "…");

  const defaultTriggerClass =
    "flex w-full items-center justify-between gap-2 rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="tree"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={className ?? `${defaultTriggerClass} cursor-pointer`}
      >
        <span className="truncate">{triggerLabel}</span>
        {!commitOnSelect && <TriggerChevronIcon />}
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              // Plain opaque bg-card, not dam-glass — dam-glass's translucent
              // background (`--glass-bg`, with backdrop-filter) would win over
              // the bg-card utility here (equal specificity, later in source
              // order) and let the card image behind the portal show through
              // in dark mode. Every other dropdown/kebab panel in the app
              // (collection kebab, breadcrumb overflow, etc.) is already
              // plain bg-card — this matches that, not the frosted content
              // cards dam-glass is meant for.
              className="fixed z-50 rounded-[10px] border border-line bg-card shadow-lg"
              style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
            >
              <div
                ref={treeRef}
                role="tree"
                aria-label="Collections"
                aria-activedescendant={activeId ? `ctp-node-${activeId}` : undefined}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                className="max-h-80 overflow-y-auto p-1.5 outline-none"
              >
                {rootLevel === "loading" && (
                  <div className="flex items-center gap-2 px-2 py-3 text-sm text-slate">
                    <Spinner /> Loading…
                  </div>
                )}
                {rootLevel === "error" && (
                  <div className="px-2 py-3 text-sm text-red-600 dark:text-red-400">
                    Could not load collections.{" "}
                    <button
                      type="button"
                      onClick={() => retry("root", null)}
                      className="cursor-pointer underline"
                    >
                      Retry
                    </button>
                  </div>
                )}
                {Array.isArray(rootLevel) && entries.length === 0 && (
                  <div className="px-2 py-3 text-sm text-slate">No collections available.</div>
                )}
                {entries.map((entry) => {
                  const isNone = entry.id === NONE_ID;
                  const isSelected = isNone ? value == null : value === entry.id;
                  const isActive = entry.id === activeId;
                  return (
                    <div
                      key={entry.id}
                      id={`ctp-node-${entry.id}`}
                      role="treeitem"
                      aria-selected={isSelected}
                      aria-expanded={entry.hasChildren ? entry.expanded : undefined}
                      aria-disabled={entry.disabled || undefined}
                      onMouseEnter={() => setActiveId(entry.id)}
                      onClick={() => selectNode(isNone ? null : entry.id, entry.disabled)}
                      className={`flex select-none items-center gap-1.5 rounded-[6px] py-1.5 pr-2 text-sm ${
                        entry.disabled ? "cursor-not-allowed text-slate/60" : "cursor-pointer text-ink hover:bg-mist"
                      } ${isSelected ? "bg-surface-tint font-medium text-brand" : ""} ${
                        isActive ? "ring-1 ring-inset ring-brand/40" : ""
                      } ${isNone ? "mb-1 border-b border-surface-tint-2 pb-2" : ""}`}
                      style={{ paddingLeft: 8 + entry.depth * 16 }}
                    >
                      {!isNone && entry.hasChildren ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(entry);
                          }}
                          aria-label={entry.expanded ? "Collapse" : "Expand"}
                          className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center"
                        >
                          <ChevronToggleIcon expanded={entry.expanded} />
                        </button>
                      ) : (
                        <span className="w-4 shrink-0" />
                      )}
                      <span className="truncate">{entry.name}</span>
                      {entry.loadingChildren && <Spinner />}
                      {entry.loadErrored && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            retry(entry.id, entry.id);
                          }}
                          className="cursor-pointer text-xs text-red-600 dark:text-red-400 underline"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
