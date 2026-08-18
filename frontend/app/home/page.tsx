"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Manrope } from "next/font/google";
import AppShell from "@/components/AppShell";
import ViewToggle, { ViewMode } from "@/components/ViewToggle";
import Select from "@/components/Select";
import { shortTypeLabel } from "@/lib/fileTypes";
import { useTranslation } from "@/lib/i18n";

const manrope = Manrope({ subsets: ["latin"], weight: ["600", "700"] });

const VIEW_STORAGE_KEY = "dam:view:collections";
const SORT_STORAGE_KEY = "dam:sort:collections";
const VALID_SORTS = ["default", "name_asc", "name_desc"];
const PAGE_SIZE_STORAGE_KEY = "dam:pagesize:home-collections";
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

// Windowed page-number list with ellipsis markers for long ranges, e.g.
// [1, "ellipsis", 4, 5, 6, "ellipsis", 12]. Always includes first and last.
function getPageNumbers(current: number, totalPages: number): (number | "ellipsis")[] {
  const delta = 1;
  const range: (number | "ellipsis")[] = [];
  const left = Math.max(2, current - delta);
  const right = Math.min(totalPages - 1, current + delta);

  range.push(1);
  if (left > 2) range.push("ellipsis");
  for (let i = left; i <= right; i++) range.push(i);
  if (right < totalPages - 1) range.push("ellipsis");
  if (totalPages > 1) range.push(totalPages);

  return range;
}

interface Collection {
  id: string;
  name: string;
  owner_id: string | null;
  created_at: string;
  cover_storage_key: string | null;
  subcollection_count: number;
  file_count: number;
}

interface SearchCollection {
  id: string;
  name: string;
  parent_id: string | null;
}

interface SearchFile {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  description: string | null;
  collection_id: string;
}

interface SearchResults {
  collections: SearchCollection[];
  files: SearchFile[];
}

interface Tenant {
  id: string;
  name: string;
}

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FolderGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 20 20" fill="none" stroke="var(--color-brand)" strokeWidth="1.5">
      <path d="M2.5 5.5A1.5 1.5 0 014 4h3.5l1.5 1.8H16A1.5 1.5 0 0117.5 7.3v7.2A1.5 1.5 0 0116 16H4a1.5 1.5 0 01-1.5-1.5v-9z" strokeLinejoin="round" />
    </svg>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  // canAdmin (role 1 or 2) may create collections — widened from super-admin-
  // only (Stage 6, reversed in this pass): a tenant admin's new collection
  // is auto-granted to their own tenant only (server-enforced, see
  // POST /api/collections). isSuperAdmin gates only the tenant-picker
  // checkboxes below, since GET /api/tenants stays super-admin-only.
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  const [collections, setCollections] = useState<Collection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [view, setView] = useState<ViewMode>("grid");
  const [sortFilter, setSortFilter] = useState("default");

  // Pagination state — page is 1-based and never persisted; pageSize is.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);

  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const createdCoverUrls = useRef<string[]>([]);

  // Create form state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenants, setSelectedTenants] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchWrapperRef = useRef<HTMLDivElement>(null);
  const searchCounterRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    const payload = parseToken(token);
    // Collection creation is now tenant-admin-and-above (POST /api/collections
    // is requireAdmin + tenant-scoped as of this pass) — canAdmin covers both
    // super_admin and admin (tenant admin).
    const superAdmin = payload?.roleName === "super_admin";
    setIsAdmin(!!payload?.canAdmin);
    setIsSuperAdmin(superAdmin);
    setAuthorized(true);

    // Companies feed the "New collection" create form's grant checkboxes —
    // only a super admin sees that picker (GET /api/tenants stays
    // requireSuperAdmin); a tenant admin's collection is auto-granted to
    // their own tenant server-side with no picker shown at all.
    if (superAdmin) {
      fetch("/api/tenants", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? (r.json() as Promise<Tenant[]>) : []))
        .then(setTenants)
        .catch(() => {});
    }
  }, [router]);

  // Fetches the current page of top-level collections. Shared by the
  // pagination effect below and by handleCreate, which refetches instead of
  // optimistically prepending — the create used to just splice the new
  // collection into local state, but that would silently exceed pageSize and
  // leave `total` stale now that this list is server-paginated.
  async function fetchCollections() {
    const token = localStorage.getItem("token");
    if (!token) return;

    const params = new URLSearchParams();
    params.set("sort", sortFilter);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    try {
      const res = await fetch(`/api/collections?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { collections: Collection[]; total: number; page: number; pageSize: number };
      setCollections(data.collections);
      setTotal(data.total);
      // The server clamps an out-of-range page to the last valid page — mirror
      // that back into state so the pager reflects where the data actually is.
      if (data.page !== page) setPage(data.page);
    } catch {
      setLoadError(t("home.error.loadFailed"));
    }
  }

  // Fetch top-level collections whenever auth is established, the sort choice
  // changes, or the page/page size changes — sorting and pagination are both
  // applied server-side.
  useEffect(() => {
    if (!authorized) return;
    fetchCollections();
  }, [authorized, sortFilter, page, pageSize]);

  // Read the persisted page-size preference on mount only — never during render/SSR.
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
      if (PAGE_SIZES.includes(stored)) setPageSize(stored);
    } catch {
      // localStorage unavailable — keep the default page size
    }
  }, []);

  function handlePageSizeChange(next: number) {
    setPageSize(next);
    setPage(1);
    try {
      localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
    } catch {
      // ignore persistence failures (e.g. private browsing)
    }
  }

  // Read the persisted view preference on mount only — never during render/SSR.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === "grid" || stored === "list") setView(stored);
    } catch {
      // localStorage unavailable — keep the 'grid' default
    }
  }, []);

  function handleViewChange(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // ignore persistence failures (e.g. private browsing)
    }
  }

  // Read the persisted sort preference on mount only — never during render/SSR.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(SORT_STORAGE_KEY);
      if (stored && VALID_SORTS.includes(stored)) setSortFilter(stored);
    } catch {
      // localStorage unavailable — keep the 'default' default
    }
  }, []);

  function handleSortChange(next: string) {
    setSortFilter(next);
    setPage(1);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore persistence failures (e.g. private browsing)
    }
  }

  // Revoke cover blob URLs on unmount.
  useEffect(() => {
    const urls = createdCoverUrls.current;
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  // Fetch cover blob URLs whenever the collection list changes.
  useEffect(() => {
    if (collections.length === 0) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    for (const c of collections) {
      if (!c.cover_storage_key) continue;
      (async () => {
        try {
          const res = await fetch(
            `/api/cover?key=${encodeURIComponent(c.cover_storage_key!)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!res.ok) return;
          const { url } = await res.json();
          const imgRes = await fetch(url);
          if (!imgRes.ok) return;
          const blob = await imgRes.blob();
          const objectUrl = URL.createObjectURL(blob);
          createdCoverUrls.current.push(objectUrl);
          setCoverUrls((prev) => ({ ...prev, [c.id]: objectUrl }));
        } catch {
          // leave absent → placeholder shown instead
        }
      })();
    }
  }, [collections]);

  // Close search dropdown on outside click or Escape.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        searchWrapperRef.current &&
        !searchWrapperRef.current.contains(e.target as Node)
      ) {
        setSearchOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSearchOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Close the create-collection modal on Escape.
  useEffect(() => {
    if (!createOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setCreateOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [createOpen]);

  // Cancel any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setSearchQuery(val);

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (!val.trim()) {
      setSearchResults(null);
      setSearchOpen(false);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    setSearchOpen(true);

    debounceTimerRef.current = setTimeout(async () => {
      const token = localStorage.getItem("token");
      if (!token) return;

      // Stamp this request; discard response if a newer one has been issued.
      const myCounter = ++searchCounterRef.current;

      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(val.trim())}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (searchCounterRef.current !== myCounter) return;
        if (!res.ok) {
          setSearchLoading(false);
          return;
        }
        const data: SearchResults = await res.json();
        if (searchCounterRef.current !== myCounter) return;
        setSearchResults(data);
        setSearchLoading(false);
      } catch {
        if (searchCounterRef.current !== myCounter) return;
        setSearchLoading(false);
      }
    }, 300);
  }

  function handleSearchNavigate(href: string) {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults(null);
    router.push(href);
  }

  function toggleTenant(id: string) {
    setSelectedTenants((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    if (!token || !newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newName.trim(), tenantIds: selectedTenants }),
      });
      if (!res.ok) {
        const err = await res.json();
        setCreateError(err.message ?? t("home.create.error.generic"));
        return;
      }
      await res.json();
      await fetchCollections();
      setNewName("");
      setSelectedTenants([]);
      setCreateOpen(false);
    } catch {
      setCreateError(t("common.error.couldNotReachServer"));
    } finally {
      setCreating(false);
    }
  }

  if (!authorized) return null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  const hasResults =
    searchResults &&
    (searchResults.collections.length > 0 || searchResults.files.length > 0);

  const searchBox = (
    <div ref={searchWrapperRef} className="relative w-72">
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="M16 16l-3.2-3.2" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={handleSearchChange}
          onFocus={() => {
            if (searchQuery.trim()) setSearchOpen(true);
          }}
          placeholder={t("home.search.placeholder")}
          className="dam-glass h-10 w-full rounded-[10px] pl-9 pr-3 text-[14px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
        />
      </div>

      {searchOpen && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1.5 max-h-96 overflow-y-auto rounded-lg border border-line bg-card shadow-lg">
          {searchLoading ? (
            <p className="px-4 py-3 text-sm text-slate">{t("shares.create.searching")}</p>
          ) : hasResults ? (
            <>
              {searchResults!.collections.length > 0 && (
                <div>
                  <p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate">
                    {t("nav.collections")}
                  </p>
                  {searchResults!.collections.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => handleSearchNavigate(`/collections/${c.id}`)}
                      className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              {searchResults!.files.length > 0 && (
                <div>
                  <p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate">
                    {t("common.files")}
                  </p>
                  {searchResults!.files.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => handleSearchNavigate(`/collections/${f.collection_id}`)}
                      className="flex w-full cursor-pointer flex-col px-4 py-2 text-left hover:bg-mist"
                    >
                      <span className="text-sm text-ink">{f.original_filename}</span>
                      <span className="text-xs text-slate">
                        {shortTypeLabel(f.mime_type, f.original_filename)} · {formatBytes(f.size_bytes)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="px-4 py-3 text-sm text-slate">{t("home.search.noResults")}</p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <AppShell
      active="collections"
      title={t("nav.collections")}
      actions={
        <>
          {searchBox}
          <Select
            value={sortFilter}
            onChange={handleSortChange}
            ariaLabel={t("home.sort.ariaLabel")}
            options={[
              { value: "default", label: t("common.sort.default") },
              { value: "name_asc", label: t("common.sort.nameAsc") },
              { value: "name_desc", label: t("common.sort.nameDesc") },
            ]}
            className="flex h-10 cursor-pointer items-center justify-between gap-2 rounded-[10px] border border-line bg-white/70 dark:bg-card px-3 text-[14px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <ViewToggle value={view} onChange={handleViewChange} />
          {isAdmin && (
            <button
              onClick={() => setCreateOpen(true)}
              className="h-10 cursor-pointer whitespace-nowrap rounded-[10px] bg-brand px-4 text-[14px] font-semibold text-white shadow-[0_6px_16px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover"
            >
              {t("home.create.newCollection")}
            </button>
          )}
        </>
      }
    >
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
      {!loadError && collections.length === 0 && (
        <p className="text-sm text-slate">{t("home.states.empty")}</p>
      )}
      {collections.length > 0 && view === "grid" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {collections.map((c) => (
            <Link
              key={c.id}
              href={`/collections/${c.id}`}
              className="dam-glass group overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)] transition-all hover:-translate-y-0.5 hover:shadow-lg"
            >
              <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-tint">
                {coverUrls[c.id] ? (
                  <>
                    {/* Blurred, zoomed backdrop — fills the box so no empty space shows */}
                    <img
                      src={coverUrls[c.id]}
                      alt=""
                      aria-hidden="true"
                      className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl"
                    />
                    {/* Full, uncropped cover on top */}
                    <img
                      src={coverUrls[c.id]}
                      alt={c.name}
                      className="relative z-10 h-full w-full object-contain"
                    />
                  </>
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <FolderGlyph />
                  </div>
                )}
              </div>
              <div className="p-3">
                <p className={`${manrope.className} truncate text-[13px] font-semibold text-ink`}>
                  {c.name}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}

      {collections.length > 0 && view === "list" && (
        <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-line/70">
                <th className="w-14 px-5 py-3" />
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("common.name")}
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("common.subcollections")}
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("common.files")}
                </th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/collections/${c.id}`)}
                  className="cursor-pointer border-b border-surface-tint-2 transition-colors last:border-b-0 hover:bg-white/40 dark:hover:bg-white/5"
                >
                  <td className="px-5 py-2.5">
                    <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[8px] bg-surface-tint">
                      {coverUrls[c.id] ? (
                        <img src={coverUrls[c.id]} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <FolderGlyph />
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-2.5">
                    <span className="text-sm font-medium text-ink">{c.name}</span>
                  </td>
                  <td className="px-5 py-2.5 text-sm text-slate">
                    {c.subcollection_count}
                  </td>
                  <td className="px-5 py-2.5 text-sm text-slate">{c.file_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pager — shared by grid and list views; both render the same page of `collections` */}
      {!loadError && total > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate">
            {t("media.pagination.showing", { start: rangeStart, end: rangeEnd, total })}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <nav className="flex items-center gap-1" aria-label={t("media.pagination.ariaLabel")}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="cursor-pointer rounded-[8px] border border-line bg-white/80 dark:bg-white/10 px-2.5 py-1.5 text-sm text-ink hover:bg-card disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("media.pagination.prev")}
              </button>
              {getPageNumbers(page, totalPages).map((p, i) =>
                p === "ellipsis" ? (
                  <span key={`ellipsis-${i}`} className="px-2 text-sm text-slate">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    aria-current={p === page ? "page" : undefined}
                    className={`cursor-pointer rounded-[8px] px-3 py-1.5 text-sm ${
                      p === page
                        ? "bg-brand font-semibold text-white"
                        : "border border-line bg-white/80 dark:bg-white/10 text-ink hover:bg-card"
                    }`}
                  >
                    {p}
                  </button>
                )
              )}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="cursor-pointer rounded-[8px] border border-line bg-white/80 dark:bg-white/10 px-2.5 py-1.5 text-sm text-ink hover:bg-card disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("media.pagination.next")}
              </button>
            </nav>

            <label className="flex items-center gap-2 text-sm text-slate">
              {t("media.pagination.perPage")}
              <Select
                ariaLabel={t("media.pagination.perPageAriaLabel")}
                value={String(pageSize)}
                onChange={(v) => handlePageSizeChange(Number(v))}
                options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </label>
          </div>
        </div>
      )}

      {/* New collection modal */}
      {createOpen && isAdmin && (
        <>
          <div
            className="fixed inset-0 z-40 bg-ink/40"
            onClick={() => setCreateOpen(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-xl">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-[18px] font-bold text-ink">{t("home.create.newCollection")}</h2>
                <button
                  onClick={() => setCreateOpen(false)}
                  aria-label={t("common.close")}
                  className="cursor-pointer rounded p-1 text-slate hover:bg-mist"
                >
                  ✕
                </button>
              </div>
              <form onSubmit={handleCreate}>
                <div className="mb-4">
                  <label className="mb-1.5 block text-[13px] font-medium text-slate">
                    {t("common.name")}
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="h-11 w-full rounded-[10px] border border-line bg-card px-3.5 text-[15px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                    placeholder={t("home.create.namePlaceholder")}
                    autoFocus
                    required
                  />
                </div>
                {/* Super-admin only — a tenant admin's collection is
                    auto-granted to their own tenant server-side (see
                    POST /api/collections), so there's no picker to show them:
                    GET /api/tenants stays requireSuperAdmin, and showing
                    every tenant's name here would leak cross-tenant data
                    a tenant admin has no reason to see. */}
                {isSuperAdmin && (
                  <div className="mb-5">
                    <p className="mb-1.5 text-[13px] font-medium text-slate">{t("common.grantAccessTo")}</p>
                    <div className="flex flex-wrap gap-4">
                      {tenants.map((c) => (
                        <label key={c.id} className="flex cursor-pointer items-center gap-1.5 text-sm text-ink">
                          <input
                            type="checkbox"
                            checked={selectedTenants.includes(c.id)}
                            onChange={() => toggleTenant(c.id)}
                          />
                          {c.name}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {createError && (
                  <p className="mb-3 text-sm text-red-600 dark:text-red-400">{createError}</p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateOpen(false)}
                    className="h-10 cursor-pointer rounded-[10px] border border-line px-4 text-sm font-medium text-ink hover:bg-mist"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !newName.trim()}
                    className="h-10 cursor-pointer rounded-[10px] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
                  >
                    {creating ? t("common.creating") : t("home.create.submit")}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
