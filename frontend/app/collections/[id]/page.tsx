"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import JSZip from "jszip";
import AppShell from "@/components/AppShell";
import MetadataDrawer from "@/components/MetadataDrawer";
import ViewToggle, { ViewMode } from "@/components/ViewToggle";
import FileTypeIcon from "@/components/FileTypeIcon";
import Select from "@/components/Select";
import { shortTypeLabel } from "@/lib/fileTypes";
import { useTranslation } from "@/lib/i18n";

type TFn = (key: string, params?: Record<string, string | number>) => string;

const VIEW_STORAGE_KEY = "dam:view:collection-detail";
const SORT_STORAGE_KEY = "dam:sort:collections";
const VALID_SORTS = ["default", "name_asc", "name_desc"];
const PAGE_SIZE_STORAGE_KEY = "dam:pagesize:collection";
const SUBCOLLECTIONS_PAGE_SIZE_STORAGE_KEY = "dam:pagesize:subcollections";
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
  parent_id: string | null;
  created_at: string;
  cover_storage_key: string | null;
  subcollection_count: number;
  file_count: number;
}

interface FileItem {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  description: string | null;
  thumbnail_storage_key: string | null;
}

interface AncestorCrumb {
  id: string;
  name: string | null;
  accessible: boolean;
}

interface AccessTenant {
  id: string;
  name: string;
  granted: boolean;
  // Context only, never editable here: set when this tenant has no grant of
  // its own on this collection but can still reach it via an ancestor's grant
  // (Stage 88 cascade). Null whenever `granted` is true.
  inheritedFrom: { id: string; name: string } | null;
}

interface AccessResponse {
  collectionId: string;
  companies: AccessTenant[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The thumbnail pipeline (POST /api/resources/[id]/thumbnail) now covers
// videos (extracted frame), PDFs (rendered first page), and images (resized
// derivative) — anywhere the old code branched on "is this a video" (later
// "video or PDF") to decide whether a generated thumbnail applies, it now
// needs to ask "is this a video, PDF, or image" instead. Kept in sync with
// SUPPORTED_IMAGE_MIME_TYPES in app/api/resources/[id]/thumbnail/route.ts.
function supportsGeneratedThumbnail(mimeType: string): boolean {
  return (
    mimeType.startsWith("video/") ||
    mimeType === "application/pdf" ||
    ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
  );
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "collection-files";
}

function InfoIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v4.5M10 6.75h.01" strokeLinecap="round" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 20 20" fill="none" stroke="var(--color-brand)" strokeWidth="1.5">
      <path d="M2.5 5.5A1.5 1.5 0 014 4h3.5l1.5 1.8H16A1.5 1.5 0 0117.5 7.3v7.2A1.5 1.5 0 0116 16H4a1.5 1.5 0 01-1.5-1.5v-9z" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronSep() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--color-border-soft)" strokeWidth="1.6" className="shrink-0">
      <path d="M7.5 4.5L13 10l-5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A breadcrumb ancestor is either a clickable link (accessible, name known) or a
// muted, non-clickable "…" — the API never sends a name for an inaccessible
// ancestor, so there is nothing to leak even if this branch were bypassed.
function renderAncestorEntry(a: AncestorCrumb, t: TFn) {
  if (!a.accessible || a.name === null) {
    return (
      <span className="text-border-soft" title={t("collections.breadcrumb.notAccessible")}>
        …
      </span>
    );
  }
  return (
    <Link
      href={`/collections/${a.id}`}
      className="inline-block max-w-[140px] truncate align-bottom text-[15px] font-medium text-slate transition-colors hover:text-brand"
      title={a.name}
    >
      {a.name}
    </Link>
  );
}

// Row list used inside both the desktop "hidden ancestors" overflow dropdown and
// the mobile "full chain" dropdown.
function renderAncestorDropdownList(list: AncestorCrumb[], onNavigate: () => void) {
  return list.map((a) => (
    <div key={a.id} className="px-3 py-1.5">
      {a.accessible && a.name !== null ? (
        <Link
          href={`/collections/${a.id}`}
          onClick={onNavigate}
          className="block truncate text-sm text-ink hover:text-brand"
          title={a.name}
        >
          {a.name}
        </Link>
      ) : (
        <span className="block text-sm text-border-soft">…</span>
      )}
    </div>
  ));
}

export default function CollectionPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const { t } = useTranslation();

  const [authorized, setAuthorized] = useState(false);
  const [canUpload, setCanUpload] = useState(false);
  const [canAdmin, setCanAdmin] = useState(false);
  // Stage 108 — the caller's own effective permission bundle
  // (GET /api/permissions/mine), used alongside canAdmin/canUpload to decide
  // which of the newly-configurable actions' buttons/kebab items to render.
  // Initialized to mirror pre-Stage-108 behavior exactly (upload/
  // edit_metadata/remove_from_collection following canUpload, download/
  // view_metadata always on) so there's no render flash while the real fetch
  // is in flight — it's corrected moments later if a tenant has actually
  // overridden anything. Every other key defaults false here (matching their
  // own code-level default) since those buttons were never shown before this
  // stage at all; canAdmin's own `||` in each gate below still covers admins
  // instantly regardless of this bundle's state.
  const [myPerms, setMyPerms] = useState<Record<string, boolean>>({
    download: true,
    view_metadata: true,
  });

  const [children, setChildren] = useState<Collection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [view, setView] = useState<ViewMode>("grid");
  const [sortFilter, setSortFilter] = useState("default");

  // Sub-collections pagination — independent of the Files pager below. page is
  // 1-based and never persisted; pageSize is.
  const [subPage, setSubPage] = useState(1);
  const [subPageSize, setSubPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [subTotal, setSubTotal] = useState(0);

  const [files, setFiles] = useState<FileItem[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  // Pagination state — files only; sub-collections stay unpaginated. page is
  // 1-based and never persisted; pageSize is.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);

  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});

  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  const [collectionDeleted, setCollectionDeleted] = useState(false);
  const [deletingCollection, setDeletingCollection] = useState(false);
  const [deleteCollectionError, setDeleteCollectionError] = useState<string | null>(null);

  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const createdObjectUrls = useRef<string[]>([]); // all blob URLs — revoked together on unmount

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "done">("idle");
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; filename: string } | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{ succeeded: number; failed: string[] } | null>(null);

  // Import from URL — lands in this collection
  const [importUrl, setImportUrl] = useState("");
  const [importStatus, setImportStatus] = useState<"idle" | "importing">("idle");
  const [importError, setImportError] = useState<string | null>(null);
  // Presentational only — toggles the top-bar "Import URL" popover
  const [importPopoverOpen, setImportPopoverOpen] = useState(false);

  // Select / bulk-download state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [zipStatus, setZipStatus] = useState<"idle" | "zipping">("idle");
  const [zipProgress, setZipProgress] = useState<{ current: number; total: number } | null>(null);
  const [zipNote, setZipNote] = useState<string | null>(null);

  // Bulk remove / bulk permanent-delete state — mirrors the media library's bulk-delete
  // shape (sequential loop, per-item progress, failure-tolerant, end-of-batch summary).
  const [bulkActionStatus, setBulkActionStatus] = useState<"idle" | "removing" | "deleting">("idle");
  const [bulkActionProgress, setBulkActionProgress] = useState<{ current: number; total: number } | null>(null);
  const [bulkActionSummary, setBulkActionSummary] = useState<string | null>(null);

  // Menu state — only one open at a time
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [colKebabOpen, setColKebabOpen] = useState(false);
  const [openChildMenuId, setOpenChildMenuId] = useState<string | null>(null);

  // Collection-kebab dropdown is portaled to document.body (see render below) to
  // escape the dam-glass backdrop-filter stacking-context trap — z-index alone
  // cannot lift it above a sub-collection card's own kebab trigger, since that
  // card is a sibling stacking context this menu's ancestor chain can never
  // outrank. Same pattern as components/CollectionTreePicker.tsx: position is
  // computed from the trigger's own bounding rect on open, not CSS layout.
  const colKebabTriggerRef = useRef<HTMLButtonElement>(null);
  const [colKebabPos, setColKebabPos] = useState<{ top: number; left: number } | null>(null);

  // Collection-level state
  const [collectionName, setCollectionName] = useState<string | null>(null);
  const [ancestors, setAncestors] = useState<AncestorCrumb[]>([]);
  const [breadcrumbOverflowOpen, setBreadcrumbOverflowOpen] = useState(false);
  const [renamingThisCollection, setRenamingThisCollection] = useState(false);
  const [renamingChildId, setRenamingChildId] = useState<string | null>(null);
  const [deletingChildId, setDeletingChildId] = useState<string | null>(null);
  const [deleteChildErrors, setDeleteChildErrors] = useState<Record<string, string>>({});
  const [creatingSubcollection, setCreatingSubcollection] = useState(false);

  // Description inline editing state (admin only)
  const [editingDescId, setEditingDescId] = useState<string | null>(null);
  const [draftDesc, setDraftDesc] = useState("");
  const [savingDescIds, setSavingDescIds] = useState<Set<string>>(new Set());
  const [descErrors, setDescErrors] = useState<Record<string, string>>({});

  // File rename state (admin only)
  const [renamingFileIds, setRenamingFileIds] = useState<Set<string>>(new Set());
  const [renameFileErrors, setRenameFileErrors] = useState<Record<string, string>>({});

  // Video thumbnail generation state (admin only)
  const [generatingThumbIds, setGeneratingThumbIds] = useState<Set<string>>(new Set());
  const [thumbnailErrors, setThumbnailErrors] = useState<Record<string, string>>({});

  // Metadata drawer — one asset at a time, all roles can open it
  const [detailsResourceId, setDetailsResourceId] = useState<string | null>(null);

  // Lightbox state
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState("");

  // Access editor state (admin only) — one modal, retargetable to whichever
  // collection triggered it: this page's own collection (top kebab) or a
  // child sub-collection (its own card kebab). Grants only ever live on a
  // root collection (see app/api/collections/[id]/access/route.ts's own
  // comments) — the modal fetches per-target rather than assuming based on
  // where it was opened from, and renders an editable form only when the
  // target actually is its own root.
  const [accessTargetId, setAccessTargetId] = useState<string | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessData, setAccessData] = useState<AccessResponse | null>(null);
  const [accessSelected, setAccessSelected] = useState<Set<string>>(new Set());
  const [accessSaving, setAccessSaving] = useState(false);

  // Cover image upload state (admin only)
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  const [coverUploadStatus, setCoverUploadStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [coverUploadError, setCoverUploadError] = useState<string | null>(null);

  // Stage 108 — per-file "Share" modal. This is the entry point that makes
  // the newly-configurable 'create_share' permission actually reachable for
  // editors/viewers: neither role had any share-creation UI before this
  // stage (POST /api/shares was admin-only), so unlike every other permission
  // in this file (which widens an *existing* button's visibility), this one
  // is a genuinely new surface. Kept deliberately minimal — one resource
  // target, no collection-target option (that stays on /admin/shares) — since
  // its only job is to make the permission clickable, not to duplicate the
  // full admin share-management page.
  const [shareModalFileId, setShareModalFileId] = useState<string | null>(null);
  const [shareAccessLevel, setShareAccessLevel] = useState<"view" | "download">("view");
  const [shareExpiresIn, setShareExpiresIn] = useState<"1d" | "7d" | "30d" | "never">("7d");
  const [shareCreating, setShareCreating] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareResult, setShareResult] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  function openShareModal(fileId: string) {
    setShareModalFileId(fileId);
    setShareAccessLevel("view");
    setShareExpiresIn("7d");
    setShareError(null);
    setShareResult(null);
    setShareCopied(false);
  }

  async function handleCreateShare() {
    if (!shareModalFileId) return;
    const token = localStorage.getItem("token");
    if (!token) return;
    setShareCreating(true);
    setShareError(null);
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          resourceId: shareModalFileId,
          accessLevel: shareAccessLevel,
          expiresIn: shareExpiresIn,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setShareError((body as { error?: string }).error ?? t("common.error.generic", { status: res.status }));
        return;
      }
      setShareResult((body as { url: string }).url);
    } catch {
      setShareError(t("common.error.couldNotReachServer"));
    } finally {
      setShareCreating(false);
    }
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    setAuthorized(true);

    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      const upload = !!payload?.canUpload;
      setCanUpload(upload);
      setCanAdmin(!!payload?.canAdmin);
      // Optimistic pre-fetch defaults (see the state declaration's own
      // comment) — corrected moments later by the real fetch below.
      setMyPerms((prev) => ({
        ...prev,
        upload,
        edit_metadata: upload,
        remove_from_collection: upload,
      }));
    } catch {
      // malformed token — leave canUpload false
    }

    // Stage 108 — the real, DB-backed permission bundle. Fetched once per
    // mount, alongside every other per-collection fetch below; corrects the
    // optimistic defaults above the moment it resolves.
    fetch(`/api/permissions/mine`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { permissions: Record<string, boolean> } | null) => {
        if (data?.permissions) setMyPerms(data.permissions);
      })
      .catch(() => {
        // Non-fatal — the optimistic defaults above stand until a reload.
      });

    fetch(`/api/collections/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((data: { id: string; name: string }) => setCollectionName(data.name))
      .catch(() => {
        // leave collectionName null — breadcrumb falls back to "Collection"
      });

    fetch(`/api/collections/${id}/ancestors`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((data: AncestorCrumb[]) => setAncestors(data))
      .catch(() => {
        // leave ancestors empty — breadcrumb falls back to Home / current only
      });
  }, [id, router]);

  // Fetches the current page of sub-collections. Shared by the pagination
  // effect below and by handleCreateSubcollection, which refetches instead of
  // optimistically prepending — a local prepend would silently exceed
  // subPageSize and leave subTotal stale now that this list is paginated.
  async function fetchSubcollections() {
    const token = localStorage.getItem("token");
    if (!token) return;

    const params = new URLSearchParams();
    params.set("parentId", id);
    params.set("sort", sortFilter);
    params.set("page", String(subPage));
    params.set("pageSize", String(subPageSize));

    try {
      const res = await fetch(`/api/collections?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { collections: Collection[]; total: number; page: number; pageSize: number };
      setChildren(data.collections);
      setSubTotal(data.total);
      // The server clamps an out-of-range page to the last valid page — mirror
      // that back into state so the pager reflects where the data actually is.
      if (data.page !== subPage) setSubPage(data.page);
    } catch {
      setLoadError(t("collections.subcollections.error.loadFailed"));
    }
  }

  // Fetch sub-collections whenever the id, sort choice, or page/page size
  // changes — sorting and pagination are both applied server-side.
  useEffect(() => {
    if (!authorized) return;
    fetchSubcollections();
  }, [id, authorized, sortFilter, subPage, subPageSize]);

  // Read the persisted page-size preference on mount only — never during render/SSR.
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(SUBCOLLECTIONS_PAGE_SIZE_STORAGE_KEY));
      if (PAGE_SIZES.includes(stored)) setSubPageSize(stored);
    } catch {
      // localStorage unavailable — keep the default page size
    }
  }, []);

  function handleSubPageSizeChange(next: number) {
    setSubPageSize(next);
    setSubPage(1);
    try {
      localStorage.setItem(SUBCOLLECTIONS_PAGE_SIZE_STORAGE_KEY, String(next));
    } catch {
      // ignore persistence failures (e.g. private browsing)
    }
  }

  // Fetches the current page of files. Shared by the pagination effect below
  // and by upload/import/bulk-action handlers that need an immediate refetch.
  async function fetchFiles() {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setFilesLoading(true);
    setFilesError(null);

    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    try {
      const res = await fetch(`/api/collections/${id}/files?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { files: FileItem[]; total: number; page: number; pageSize: number };
      setFiles(data.files);
      setTotal(data.total);
      // The server clamps an out-of-range page to the last valid page — mirror
      // that back into state so the pager reflects where the data actually is
      // (this is also what makes "delete the last item on the last page" step back).
      if (data.page !== page) setPage(data.page);
    } catch {
      setFilesError(t("collections.files.error.loadFailed"));
    } finally {
      setFilesLoading(false);
    }
  }

  // Fetch files whenever the collection, page, or page size changes.
  useEffect(() => {
    if (!authorized) return;
    fetchFiles();
  }, [id, authorized, page, pageSize]);

  // Selection is per-page: leaving the page you selected on drops the selection
  // and exits select mode entirely (there's nothing left selected to act on).
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [page]);

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
    setSubPage(1);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore persistence failures (e.g. private browsing)
    }
  }

  // Revoke all blob URLs when the component unmounts to avoid memory leaks.
  useEffect(() => {
    const urls = createdObjectUrls.current;
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  // Close lightbox on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxUrl(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Close the breadcrumb overflow dropdown on Escape — same pattern as AppShell's
  // account menu (the other kebabs on this page only close via the backdrop click).
  useEffect(() => {
    if (!breadcrumbOverflowOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setBreadcrumbOverflowOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [breadcrumbOverflowOpen]);

  // Fetch cover blob URLs for sub-collections whenever the children list changes.
  useEffect(() => {
    if (!authorized || children.length === 0) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    for (const c of children) {
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
          createdObjectUrls.current.push(objectUrl);
          setCoverUrls((prev) => ({ ...prev, [c.id]: objectUrl }));
        } catch {
          // leave absent → gray placeholder shown instead
        }
      })();
    }
  }, [children, authorized]);

  // Fetch thumbnail blob URLs for image files, and for video files that
  // already have a generated thumbnail_storage_key, whenever the file list changes.
  useEffect(() => {
    if (!authorized || files.length === 0) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    for (const f of files) {
      // Any file with a generated thumbnail (video, PDF, or now image) fetches
      // that small derivative via /api/cover?key= — never the full original.
      // Images fall back to fetching the full original via /api/download/[id]
      // only when no thumbnail exists yet (pre-rollout files, or a just-
      // uploaded image whose fire-and-forget generation hasn't landed yet),
      // so a card never goes blank while generation is in flight.
      if (f.thumbnail_storage_key) {
        (async () => {
          try {
            const res = await fetch(
              `/api/cover?key=${encodeURIComponent(f.thumbnail_storage_key!)}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!res.ok) return;
            const { url } = await res.json();
            const imgRes = await fetch(url);
            if (!imgRes.ok) return;
            const blob = await imgRes.blob();
            const objectUrl = URL.createObjectURL(blob);
            createdObjectUrls.current.push(objectUrl);
            setThumbnailUrls((prev) => ({ ...prev, [f.id]: objectUrl }));
          } catch {
            // leave absent → type label shown instead
          }
        })();
      } else if (f.mime_type.startsWith("image/")) {
        (async () => {
          try {
            const res = await fetch(`/api/download/${f.id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return;
            const { downloadUrl } = await res.json();
            const imgRes = await fetch(downloadUrl);
            if (!imgRes.ok) return;
            const blob = await imgRes.blob();
            const objectUrl = URL.createObjectURL(blob);
            createdObjectUrls.current.push(objectUrl);
            setThumbnailUrls((prev) => ({ ...prev, [f.id]: objectUrl }));
          } catch {
            // leave absent → type label shown instead
          }
        })();
      }
    }
  }, [files, authorized]);

  function toggleSelect(fileId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) =>
      prev.size === files.length && files.length > 0
        ? new Set()
        : new Set(files.map((f) => f.id))
    );
  }

  async function handleBulkDownload() {
    if (selectedIds.size === 0) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setZipStatus("zipping");
    setZipProgress({ current: 0, total: selectedIds.size });
    setZipNote(null);

    const zip = new JSZip();
    const usedNames = new Map<string, number>();
    let skipped = 0;
    const ids = Array.from(selectedIds);

    for (let i = 0; i < ids.length; i++) {
      const fileId = ids[i];
      const fileItem = files.find((f) => f.id === fileId);
      const rawName = fileItem?.original_filename ?? fileId;

      try {
        const res = await fetch(`/api/download/${fileId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const { downloadUrl } = await res.json();
        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) throw new Error("fetch");
        const blob = await fileRes.blob();

        // Deduplicate filenames within the zip
        const count = usedNames.get(rawName) ?? 0;
        usedNames.set(rawName, count + 1);
        let zipName = rawName;
        if (count > 0) {
          const dot = rawName.lastIndexOf(".");
          zipName = dot > 0
            ? `${rawName.slice(0, dot)} (${count + 1})${rawName.slice(dot)}`
            : `${rawName} (${count + 1})`;
        }

        zip.file(zipName, blob);
      } catch {
        skipped++;
      }

      setZipProgress({ current: i + 1, total: ids.length });
    }

    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const objectUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${sanitizeFilename(collectionName ?? "")}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);

    setZipStatus("idle");
    setZipProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    if (skipped > 0) {
      setZipNote(t("collections.bulk.skippedNote", { count: skipped }));
    }
  }

  // Bulk "Remove from collection" — loops the exact same DELETE endpoint as the
  // single-file handleRemove (unlink via collection_resource; file survives in the
  // media library). One batch-level confirm instead of per-file, failure-tolerant.
  async function handleBulkRemove() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const confirmMsg = t("collections.bulk.removeConfirm", { count: ids.length });
    if (!confirm(confirmMsg)) return;

    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setBulkActionStatus("removing");
    setBulkActionSummary(null);
    setBulkActionProgress({ current: 0, total: ids.length });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i++) {
      try {
        const res = await fetch(`/api/collections/${id}/files/${ids[i]}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        succeeded++;
      } catch {
        failed++;
        // continue with remaining files regardless of failure
      }
      setBulkActionProgress({ current: i + 1, total: ids.length });
    }

    setBulkActionStatus("idle");
    setBulkActionProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkActionSummary(
      t("collections.bulk.removedClause", { count: succeeded }) +
        (failed > 0 ? t("common.listSeparator") + t("media.upload.failedClause", { count: failed }) : "")
    );
    await fetchFiles();
  }

  // Bulk "Delete permanently" (admin-only) — loops the exact same DELETE endpoint as
  // the single-file handlePermanentDelete (deletes the DB row + MinIO bytes, cascading
  // out of every collection). One batch-level confirm, failure-tolerant.
  async function handleBulkPermanentDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const confirmMsg = t("collections.bulk.deleteConfirm", { count: ids.length });
    if (!confirm(confirmMsg)) return;

    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setBulkActionStatus("deleting");
    setBulkActionSummary(null);
    setBulkActionProgress({ current: 0, total: ids.length });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i++) {
      try {
        const res = await fetch(`/api/resources/${ids[i]}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        succeeded++;
      } catch {
        failed++;
        // continue with remaining files regardless of failure
      }
      setBulkActionProgress({ current: i + 1, total: ids.length });
    }

    setBulkActionStatus("idle");
    setBulkActionProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkActionSummary(
      t("media.bulk.deletedClause", { count: succeeded }) +
        (failed > 0 ? t("common.listSeparator") + t("media.upload.failedClause", { count: failed }) : "")
    );
    await fetchFiles();
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setUploadStatus("uploading");
    setUploadSummary(null);

    const failed: string[] = [];
    const uploadedIds: string[] = [];
    let succeeded = 0;

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      setUploadProgress({ current: i + 1, total: selectedFiles.length, filename: file.name });

      try {
        // Step 1: presigned PUT URL
        const urlRes = await fetch("/api/upload/url", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type }),
        });
        if (!urlRes.ok) throw new Error("url");
        const { uploadUrl, key } = await urlRes.json();

        // Step 2: PUT directly to MinIO — presigned URL handles auth
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!putRes.ok) throw new Error("minio");

        // Step 3: register in DB and link to this collection
        const completeRes = await fetch("/api/upload/complete", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            key,
            filename: file.name,
            contentType: file.type,
            size: file.size,
            collectionId: id,
          }),
        });
        if (!completeRes.ok) throw new Error("complete");
        const resource = await completeRes.json();
        if (resource?.id) uploadedIds.push(resource.id);

        // Fire-and-forget thumbnail generation for videos, PDFs, and images —
        // never blocks the upload flow or summary; the thumbnail appears on
        // the next list refresh.
        if (supportsGeneratedThumbnail(file.type) && resource?.id) {
          fetch(`/api/resources/${resource.id}/thumbnail`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }

        succeeded++;
      } catch {
        failed.push(file.name);
        // continue with remaining files regardless of failure
      }
    }

    setSelectedFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setUploadProgress(null);
    setUploadSummary({ succeeded, failed });
    setUploadStatus("done");

    if (succeeded > 0) await fetchFiles();

    // Route the newly-created assets into the "Save and next" metadata
    // workflow, one at a time. Failed uploads never got a resource id, so
    // they're naturally excluded from the queue.
    if (uploadedIds.length > 0) {
      const batch = uploadedIds.join(",");
      router.push(
        `/resources/${uploadedIds[0]}/metadata?batch=${encodeURIComponent(batch)}&i=0&return=${encodeURIComponent(`/collections/${id}`)}`
      );
    }
  }

  async function handleImportFromUrl() {
    const url = importUrl.trim();
    if (!url) { setImportError(t("media.import.enterUrl")); return; }
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setImportStatus("importing");
    setImportError(null);

    try {
      const res = await fetch("/api/upload/from-url", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, collectionId: id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? t("media.import.genericError"));

      // Fire-and-forget thumbnail generation — same trigger as direct upload
      // above. Import-from-URL only ever creates images today (see
      // upload/from-url's own content-type allow-list), so in practice this
      // only ever fires the image branch, but it's gated the same general
      // way in case that ever changes.
      if (data?.id && typeof data.mime_type === "string" && supportsGeneratedThumbnail(data.mime_type)) {
        fetch(`/api/resources/${data.id}/thumbnail`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }

      setImportUrl("");
      await fetchFiles();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : t("media.import.genericError"));
    } finally {
      setImportStatus("idle");
    }
  }

  async function handleDownload(fileId: string, filename: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setDownloadingIds((prev) => new Set(prev).add(fileId));
    setDownloadErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/download/${fileId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403) {
        setDownloadErrors((prev) => ({
          ...prev,
          [fileId]: t("collections.download.error.forbidden"),
        }));
        return;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const fileRes = await fetch(data.downloadUrl);
      const blob = await fileRes.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      setDownloadErrors((prev) => ({
        ...prev,
        [fileId]: t("collections.download.error.failed"),
      }));
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  // The lightbox must always show the full-resolution original — never the
  // small generated thumbnail a card may be using for `thumbnailUrls[f.id]`.
  // For images this means a distinct fetch via /api/download/[id], done on
  // demand only when the lightbox is actually opened (not eagerly for every
  // card, which would defeat the point of switching cards to thumbnails).
  // Video/PDF have no "original that's also an image" to show in an <img>
  // lightbox, so they keep showing their already-loaded thumbnail, same as
  // before this feature.
  async function openLightbox(f: FileItem) {
    // Fire-and-forget "view" log — every lightbox open, any file type, not
    // just images; never awaited, never blocks opening the lightbox itself.
    const viewToken = localStorage.getItem("token");
    if (viewToken) {
      fetch(`/api/resources/${f.id}/view`, {
        method: "POST",
        headers: { Authorization: `Bearer ${viewToken}` },
      }).catch(() => {});
    }
    if (f.mime_type.startsWith("image/")) {
      const token = localStorage.getItem("token");
      if (token) {
        try {
          const res = await fetch(`/api/download/${f.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const { downloadUrl } = await res.json();
            const imgRes = await fetch(downloadUrl);
            if (imgRes.ok) {
              const blob = await imgRes.blob();
              const objectUrl = URL.createObjectURL(blob);
              createdObjectUrls.current.push(objectUrl);
              setLightboxUrl(objectUrl);
              setLightboxAlt(f.original_filename);
              return;
            }
          }
        } catch {
          // fall through to the thumbnail fallback below
        }
      }
    }
    setLightboxUrl(thumbnailUrls[f.id]);
    setLightboxAlt(f.original_filename);
  }

  async function handleRemove(fileId: string) {
    if (!confirm(t("collections.remove.confirm"))) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setRemovingIds((prev) => new Set(prev).add(fileId));
    setRemoveErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/collections/${id}/files/${fileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
    } catch {
      setRemoveErrors((prev) => ({
        ...prev,
        [fileId]: t("collections.remove.error.failed"),
      }));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  async function handlePermanentDelete(fileId: string) {
    if (!confirm(t("media.bulk.deleteConfirm", { count: 1 }))) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setDeletingIds((prev) => new Set(prev).add(fileId));
    setDeleteErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/resources/${fileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
    } catch {
      setDeleteErrors((prev) => ({
        ...prev,
        [fileId]: t("media.error.deleteFailed"),
      }));
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  async function handleDeleteCollection() {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setDeleteCollectionError(null);
    setDeletingCollection(true);

    try {
      const countRes = await fetch(`/api/collections/${id}/descendant-count`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!countRes.ok) throw new Error("count");
      const { count } = await countRes.json();

      const n = Number(count);
      const msg = n === 0
        ? t("collections.deleteCollection.confirmNoChildren")
        : t("collections.deleteCollection.confirmWithChildren", { count: n });
      if (!confirm(msg)) { setDeletingCollection(false); return; }

      const res = await fetch(`/api/collections/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setCollectionDeleted(true);
    } catch {
      setDeleteCollectionError(t("collections.deleteCollection.error.failed"));
    } finally {
      setDeletingCollection(false);
    }
  }

  async function handleSaveDescription(fileId: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setSavingDescIds((prev) => new Set(prev).add(fileId));
    setDescErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/resources/${fileId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ description: draftDesc }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { description } = await res.json();
      setFiles((prev) =>
        prev.map((f) => f.id === fileId ? { ...f, description: description ?? null } : f)
      );
      setEditingDescId(null);
    } catch {
      setDescErrors((prev) => ({ ...prev, [fileId]: t("collections.description.error.saveFailed") }));
    } finally {
      setSavingDescIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  async function handleCoverUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (coverFileInputRef.current) coverFileInputRef.current.value = "";
    if (!file) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setCoverUploadStatus("uploading");
    setCoverUploadError(null);

    try {
      const urlRes = await fetch("/api/upload/url", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });
      if (!urlRes.ok) throw new Error("url");
      const { uploadUrl, key } = await urlRes.json();

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("minio");

      const patchRes = await fetch(`/api/collections/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ coverStorageKey: key }),
      });
      if (!patchRes.ok) throw new Error("patch");

      setCoverUploadStatus("done");
    } catch (err) {
      const step = err instanceof Error ? err.message : "";
      setCoverUploadError(
        step === "minio"
          ? t("collections.cover.error.uploadFailed")
          : step === "patch"
          ? t("collections.cover.error.saveFailed")
          : t("collections.cover.error.startFailed"),
      );
      setCoverUploadStatus("error");
    }
  }

  async function openAccessModal(targetId: string) {
    setColKebabOpen(false);
    setOpenChildMenuId(null);
    setAccessTargetId(targetId);
    setAccessData(null);
    setAccessError(null);
    setAccessSelected(new Set());
    setAccessLoading(true);

    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    try {
      const res = await fetch(`/api/collections/${targetId}/access`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data: AccessResponse = await res.json();
      setAccessData(data);
      setAccessSelected(new Set(data.companies.filter((c) => c.granted).map((c) => c.id)));
    } catch {
      setAccessError(t("collections.access.error.loadFailed"));
    } finally {
      setAccessLoading(false);
    }
  }

  function closeAccessModal() {
    setAccessTargetId(null);
    setAccessData(null);
    setAccessError(null);
    setAccessSaving(false);
  }

  function toggleAccessTenant(tenantId: string) {
    setAccessSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  }

  async function handleSaveAccess() {
    if (!accessTargetId || !accessData) return;
    const tenantIds = [...accessSelected];

    const confirmMsg =
      tenantIds.length === 0
        ? t("collections.access.confirmRemoveAll")
        : t("collections.access.confirmSave");
    if (!confirm(confirmMsg)) return;

    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setAccessSaving(true);
    setAccessError(null);
    try {
      const res = await fetch(`/api/collections/${accessTargetId}/access`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tenantIds }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      closeAccessModal();
    } catch {
      setAccessError(t("collections.access.error.saveFailed"));
      setAccessSaving(false);
    }
  }

  async function handleRenameThisCollection() {
    const newName = prompt(t("collections.rename.prompt"), collectionName ?? "")?.trim();
    if (!newName) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setRenamingThisCollection(true);
    try {
      const res = await fetch(`/api/collections/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setCollectionName(newName);
    } catch {
      alert(t("collections.error.renameFailed"));
    } finally {
      setRenamingThisCollection(false);
    }
  }

  async function handleRenameChild(childId: string, currentName: string) {
    const newName = prompt(t("collections.rename.prompt"), currentName)?.trim();
    if (!newName) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setRenamingChildId(childId);
    try {
      const res = await fetch(`/api/collections/${childId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setChildren((prev) => prev.map((c) => c.id === childId ? { ...c, name: newName } : c));
    } catch {
      alert(t("collections.error.renameFailed"));
    } finally {
      setRenamingChildId(null);
    }
  }

  async function handleCreateSubcollection() {
    const name = prompt(t("collections.create.subcollectionPrompt"))?.trim();
    if (!name) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setCreatingSubcollection(true);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId: id }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await res.json();
      await fetchSubcollections();
    } catch {
      alert(t("collections.error.createSubcollectionFailed"));
    } finally {
      setCreatingSubcollection(false);
    }
  }

  async function handleDeleteChild(childId: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setDeleteChildErrors((prev) => ({ ...prev, [childId]: "" }));
    setDeletingChildId(childId);

    try {
      const countRes = await fetch(`/api/collections/${childId}/descendant-count`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!countRes.ok) throw new Error("count");
      const { count } = await countRes.json();

      const n = Number(count);
      const msg = n === 0
        ? t("collections.deleteCollection.confirmNoChildren")
        : t("collections.deleteCollection.confirmWithChildren", { count: n });
      if (!confirm(msg)) { setDeletingChildId(null); return; }

      const res = await fetch(`/api/collections/${childId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setChildren((prev) => prev.filter((c) => c.id !== childId));
    } catch {
      setDeleteChildErrors((prev) => ({ ...prev, [childId]: t("collections.deleteCollection.error.failed") }));
    } finally {
      setDeletingChildId(null);
    }
  }

  async function handleRenameFile(fileId: string, currentFilename: string) {
    const newName = prompt(t("media.rename.prompt"), currentFilename)?.trim();
    if (!newName) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setRenamingFileIds((prev) => new Set(prev).add(fileId));
    setRenameFileErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/resources/${fileId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ originalFilename: newName }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { original_filename } = await res.json();
      setFiles((prev) =>
        prev.map((f) => f.id === fileId ? { ...f, original_filename } : f)
      );
    } catch {
      setRenameFileErrors((prev) => ({ ...prev, [fileId]: t("media.error.renameFailed") }));
    } finally {
      setRenamingFileIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  async function handleGenerateThumbnail(fileId: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setGeneratingThumbIds((prev) => new Set(prev).add(fileId));
    setThumbnailErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/resources/${fileId}/thumbnail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { thumbnailStorageKey } = await res.json();
      setFiles((prev) =>
        prev.map((f) => f.id === fileId ? { ...f, thumbnail_storage_key: thumbnailStorageKey } : f)
      );
    } catch {
      setThumbnailErrors((prev) => ({ ...prev, [fileId]: t("media.error.thumbnailFailed") }));
    } finally {
      setGeneratingThumbIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  async function handleRegenerateThumbnail(fileId: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setGeneratingThumbIds((prev) => new Set(prev).add(fileId));
    setThumbnailErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/resources/${fileId}/thumbnail?force=true`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { thumbnailStorageKey } = await res.json();
      setFiles((prev) =>
        prev.map((f) => f.id === fileId ? { ...f, thumbnail_storage_key: thumbnailStorageKey } : f)
      );

      // The storage key is deterministic (thumbnails/<id>.jpg) and doesn't
      // change on regenerate, so the file-state update above won't by itself
      // guarantee a fresh fetch — pull a new presigned URL + blob directly
      // so the card shows the just-regenerated image, not a stale cached one.
      const coverRes = await fetch(
        `/api/cover?key=${encodeURIComponent(thumbnailStorageKey)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (coverRes.ok) {
        const { url } = await coverRes.json();
        const imgRes = await fetch(url);
        if (imgRes.ok) {
          const blob = await imgRes.blob();
          const objectUrl = URL.createObjectURL(blob);
          createdObjectUrls.current.push(objectUrl);
          setThumbnailUrls((prev) => ({ ...prev, [fileId]: objectUrl }));
        }
      }
    } catch {
      setThumbnailErrors((prev) => ({ ...prev, [fileId]: t("media.error.thumbnailRegenFailed") }));
    } finally {
      setGeneratingThumbIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  if (!authorized) return null;

  if (collectionDeleted) {
    return (
      <AppShell active="collections" title={t("collections.deleted.title")}>
        <div className="dam-glass rounded-[13px] p-10 text-center shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
          <p className="text-base font-medium text-ink">{t("collections.deleted.message")}</p>
          <Link href="/home" className="mt-4 inline-block text-sm text-brand hover:underline">
            {"← "}{t("common.backToHome")}
          </Link>
        </div>
      </AppShell>
    );
  }

  const showStatusStrip =
    uploadStatus !== "idle" || importStatus === "importing" || !!importError;

  // Breadcrumb (top-bar left) — Home / ancestor chain / real collection name, admin-only kebab.
  // Desktop collapses the middle of a long chain into a single "…" overflow (Home, the
  // last ancestor, and the current collection always stay visible); mobile always
  // collapses the whole chain to Home / … / current. Either "…" opens a small dropdown;
  // an individual inaccessible ancestor instead renders as its own muted, static "…".
  const ancestorCount = ancestors.length;
  const overflowing = 2 + ancestorCount > 4;
  const hiddenAncestors = overflowing ? ancestors.slice(0, ancestorCount - 1) : [];
  const visibleAncestors = overflowing ? ancestors.slice(ancestorCount - 1) : ancestors;

  function toggleBreadcrumbOverflow() {
    setColKebabOpen(false);
    setOpenMenuId(null);
    setOpenChildMenuId(null);
    setImportPopoverOpen(false);
    setBreadcrumbOverflowOpen((v) => !v);
  }

  const breadcrumb = (
    <div className="flex min-w-0 items-center gap-2">
      <Link
        href="/home"
        className="shrink-0 text-[15px] font-medium text-slate transition-colors hover:text-brand"
      >
        {t("collections.breadcrumb.home")}
      </Link>

      {/* Desktop trail: full ancestor chain, or collapsed with a "…" overflow when long */}
      <div className="hidden min-w-0 items-center gap-2 sm:flex">
        {overflowing && (
          <>
            <ChevronSep />
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={toggleBreadcrumbOverflow}
                aria-label={t("collections.breadcrumb.showHidden")}
                aria-expanded={breadcrumbOverflowOpen}
                className="cursor-pointer text-[15px] font-medium text-slate transition-colors hover:text-brand"
              >
                …
              </button>
              {breadcrumbOverflowOpen && (
                <div className="absolute left-0 top-7 z-20 max-h-72 w-56 overflow-y-auto rounded-[10px] border border-line bg-card py-1 shadow-lg">
                  {renderAncestorDropdownList(hiddenAncestors, () => setBreadcrumbOverflowOpen(false))}
                </div>
              )}
            </div>
          </>
        )}
        {visibleAncestors.map((a) => (
          <span key={a.id} className="flex shrink-0 items-center gap-2">
            <ChevronSep />
            {renderAncestorEntry(a, t)}
          </span>
        ))}
      </div>

      {/* Mobile trail: Home / … / current — "…" opens the full ancestor chain */}
      {ancestorCount > 0 && (
        <div className="flex shrink-0 items-center gap-2 sm:hidden">
          <ChevronSep />
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={toggleBreadcrumbOverflow}
              aria-label={t("collections.breadcrumb.showAll")}
              aria-expanded={breadcrumbOverflowOpen}
              className="cursor-pointer text-[15px] font-medium text-slate transition-colors hover:text-brand"
            >
              …
            </button>
            {breadcrumbOverflowOpen && (
              <div className="absolute left-0 top-7 z-20 max-h-72 w-56 overflow-y-auto rounded-[10px] border border-line bg-card py-1 shadow-lg">
                {renderAncestorDropdownList(ancestors, () => setBreadcrumbOverflowOpen(false))}
              </div>
            )}
          </div>
        </div>
      )}

      <ChevronSep />
      <span
        className="inline-block min-w-0 max-w-[200px] truncate align-bottom text-[15px] font-semibold text-ink"
        title={collectionName ?? t("collections.breadcrumb.fallbackName")}
      >
        {collectionName ?? t("collections.breadcrumb.fallbackName")}
      </span>

      {/* Collection kebab — admin, or an editor granted create_collection/
          rename_collection (Stage 108); Change thumbnail/Access/Delete have
          no permission key and stay admin/cross-tenant-tier only, gated inside. */}
      {(canAdmin || myPerms.create_collection || myPerms.rename_collection) && (
        <div className="relative z-20 ml-1">
          <button
            ref={colKebabTriggerRef}
            onClick={() => {
              setOpenMenuId(null);
              setOpenChildMenuId(null);
              setImportPopoverOpen(false);
              setBreadcrumbOverflowOpen(false);
              setColKebabOpen((v) => {
                const next = !v;
                if (next) {
                  const rect = colKebabTriggerRef.current?.getBoundingClientRect();
                  if (rect) setColKebabPos({ top: rect.bottom + 8, left: rect.left });
                }
                return next;
              });
            }}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-slate hover:bg-mist"
            aria-label={t("collections.kebab.collectionActions")}
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <circle cx="10" cy="4" r="1.5" />
              <circle cx="10" cy="10" r="1.5" />
              <circle cx="10" cy="16" r="1.5" />
            </svg>
          </button>
          {colKebabOpen &&
            colKebabPos &&
            createPortal(
              // Portaled to document.body, positioned fixed from the trigger's own
              // bounding rect (set on open, above) — same escape hatch as
              // components/CollectionTreePicker.tsx. z-index could not fix this:
              // this menu's ancestor chain (however high its own z-index) is still
              // capped below a sub-collection card's kebab trigger, itself a sibling
              // dam-glass stacking context this menu's branch can never outrank.
              // Items/handlers/disabled-states below are unchanged from the
              // previous absolutely-positioned version; only the positioning and
              // portal target changed. Closing still goes through the existing
              // shared backdrop (rendered elsewhere in this component) — no new
              // backdrop or Escape handler added here, matching every other menu
              // on this page except the breadcrumb overflow dropdown.
              <div
                className="fixed z-50 w-52 rounded-[10px] border border-line bg-card py-1 text-left shadow-lg"
                style={{ top: colKebabPos.top, left: colKebabPos.left }}
              >
                {(canAdmin || myPerms.create_collection) && (
                  <button
                    onClick={() => { setColKebabOpen(false); handleCreateSubcollection(); }}
                    disabled={creatingSubcollection}
                    className="w-full cursor-pointer px-4 py-2 text-left text-sm font-normal text-ink hover:bg-mist disabled:opacity-50"
                  >
                    {creatingSubcollection ? t("common.creating") : t("collections.kebab.newSubcollection")}
                  </button>
                )}
                {(canAdmin || myPerms.rename_collection) && (
                  <button
                    onClick={() => { setColKebabOpen(false); handleRenameThisCollection(); }}
                    disabled={renamingThisCollection}
                    className="w-full cursor-pointer px-4 py-2 text-left text-sm font-normal text-ink hover:bg-mist disabled:opacity-50"
                  >
                    {renamingThisCollection ? t("common.renaming") : t("common.rename")}
                  </button>
                )}
                {canAdmin && (
                <button
                  onClick={() => { setColKebabOpen(false); coverFileInputRef.current?.click(); }}
                  disabled={coverUploadStatus === "uploading"}
                  className="w-full cursor-pointer px-4 py-2 text-left text-sm font-normal text-ink hover:bg-mist disabled:opacity-50"
                >
                  {coverUploadStatus === "uploading" ? t("collections.cover.uploading") : t("collections.kebab.changeThumbnail")}
                </button>
                )}
                {canAdmin && (
                <>
                <button
                  onClick={() => { setColKebabOpen(false); openAccessModal(id); }}
                  className="w-full cursor-pointer px-4 py-2 text-left text-sm font-normal text-ink hover:bg-mist"
                >
                  {t("collections.access.menuLabel")}
                </button>
                <button
                  onClick={() => { setColKebabOpen(false); handleDeleteCollection(); }}
                  disabled={deletingCollection}
                  className="w-full cursor-pointer px-4 py-2 text-left text-sm font-normal text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                >
                  {deletingCollection ? t("common.deleting") : t("collections.kebab.deleteCollection")}
                </button>
                </>
                )}
              </div>,
              document.body,
            )}
        </div>
      )}
    </div>
  );

  // Top-bar actions (right) — view toggle (all roles) + Import URL/Upload.
  // Stage 108: was canUpload alone — now the per-tenant 'upload' permission
  // (myPerms already resolves true unconditionally for admin tiers).
  const topBarActions = (
    <>
      <ViewToggle value={view} onChange={handleViewChange} />
      {myPerms.upload && (
      <>
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setColKebabOpen(false);
            setOpenMenuId(null);
            setOpenChildMenuId(null);
            setBreadcrumbOverflowOpen(false);
            setImportPopoverOpen((v) => !v);
          }}
          className="h-10 cursor-pointer whitespace-nowrap rounded-[10px] border border-line bg-white/70 dark:bg-white/10 px-4 text-[14px] font-medium text-ink transition-colors hover:bg-card"
        >
          {t("media.import.button")}
        </button>
        {importPopoverOpen && (
          <div className="absolute right-0 top-full z-50 mt-1.5 w-80 rounded-[10px] border border-line bg-card p-3 shadow-lg">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={importUrl}
                onChange={(e) => { setImportUrl(e.target.value); setImportError(null); }}
                placeholder={t("media.import.placeholder")}
                disabled={importStatus === "importing"}
                className="min-w-0 flex-1 rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-50"
              />
              <button
                onClick={handleImportFromUrl}
                disabled={importStatus === "importing" || !importUrl.trim()}
                className="cursor-pointer whitespace-nowrap rounded-[8px] bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
              >
                {importStatus === "importing" ? t("media.import.submitting") : t("media.import.submit")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Hidden multi-file input for upload — same onChange/upload pipeline */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={uploadStatus === "uploading"}
        onChange={(e) => {
          setSelectedFiles(Array.from(e.target.files ?? []));
          setUploadStatus("idle");
          setUploadSummary(null);
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => {
          if (selectedFiles.length > 0) handleUpload();
          else fileInputRef.current?.click();
        }}
        disabled={uploadStatus === "uploading"}
        className="h-10 cursor-pointer whitespace-nowrap rounded-[10px] bg-brand px-4 text-[14px] font-semibold text-white shadow-[0_6px_16px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:opacity-50"
      >
        {uploadStatus === "uploading"
          ? t("media.upload.uploadingShort", { current: uploadProgress?.current ?? "…", total: uploadProgress?.total ?? "…" })
          : selectedFiles.length > 0
          ? t("media.upload.button", { count: selectedFiles.length })
          : t("media.upload.buttonIdle")}
      </button>
      </>
      )}
    </>
  );

  const detailsFile = files.find((f) => f.id === detailsResourceId) ?? null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  const subTotalPages = Math.max(1, Math.ceil(subTotal / subPageSize));
  const subRangeStart = subTotal === 0 ? 0 : (subPage - 1) * subPageSize + 1;
  const subRangeEnd = Math.min(subPage * subPageSize, subTotal);

  return (
    <AppShell active="collections" title={breadcrumb} actions={topBarActions}>
      {/* Transparent backdrop — closes any open menu/popover on outside click */}
      {(openMenuId !== null || colKebabOpen || openChildMenuId !== null || importPopoverOpen || breadcrumbOverflowOpen) && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => {
            setOpenMenuId(null);
            setColKebabOpen(false);
            setOpenChildMenuId(null);
            setImportPopoverOpen(false);
            setBreadcrumbOverflowOpen(false);
          }}
        />
      )}

      {/* Hidden file input for cover image (admin only) */}
      {canAdmin && (
        <input
          ref={coverFileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleCoverUpload}
        />
      )}

      {/* Lightbox overlay */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/40"
            aria-label={t("common.close")}
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
          <img
            src={lightboxUrl}
            alt={lightboxAlt}
            className="max-h-[90vh] max-w-[90vw] object-contain rounded shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Share modal (Stage 108) — the new entry point that makes an
          editor/viewer's create_share permission actually reachable. Plain
          top-level fixed overlay, same convention as the lightbox above. */}
      {shareModalFileId && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setShareModalFileId(null)}
        >
          <div
            className="dam-glass w-full max-w-sm rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-ink">{t("shares.create.heading")}</p>

            {!shareResult ? (
              <>
                <div className="mt-4 flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate">{t("collections.share.accessLevelLabel")}</label>
                  <Select
                    value={shareAccessLevel}
                    onChange={(v) => setShareAccessLevel(v as "view" | "download")}
                    options={[
                      { value: "view", label: t("shares.access.viewOnly") },
                      { value: "download", label: t("collections.share.allowDownload") },
                    ]}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                  />
                </div>
                <div className="mt-3 flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate">{t("common.expires")}</label>
                  <Select
                    value={shareExpiresIn}
                    onChange={(v) => setShareExpiresIn(v as "1d" | "7d" | "30d" | "never")}
                    options={[
                      { value: "1d", label: t("shares.expiry.1d") },
                      { value: "7d", label: t("shares.expiry.7d") },
                      { value: "30d", label: t("shares.expiry.30d") },
                      { value: "never", label: t("shares.expiry.never") },
                    ]}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                  />
                </div>
                {shareError && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{shareError}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => setShareModalFileId(null)}
                    className="cursor-pointer rounded-[8px] border border-line bg-white/60 dark:bg-white/10 px-3 py-1.5 text-sm font-medium text-ink hover:bg-mist"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    onClick={handleCreateShare}
                    disabled={shareCreating}
                    className="cursor-pointer rounded-[8px] bg-brand px-3 py-1.5 text-sm font-medium text-white shadow-[0_4px_12px_var(--shadow-color-brand)] hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {shareCreating ? t("common.creating") : t("collections.share.createLink")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-3 text-xs text-amber-800 dark:text-amber-300">
                  {t("collections.share.copyHint")}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    readOnly
                    value={shareResult}
                    className="min-w-0 flex-1 rounded-[8px] border border-line bg-card px-3 py-1.5 text-xs text-ink"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(shareResult).then(() => {
                        setShareCopied(true);
                        setTimeout(() => setShareCopied(false), 2000);
                      });
                    }}
                    className="cursor-pointer whitespace-nowrap rounded-[8px] border border-line bg-white/60 dark:bg-white/10 px-3 py-1.5 text-xs font-medium text-ink hover:bg-mist"
                  >
                    {shareCopied ? t("shares.create.copied") : t("shares.create.copy")}
                  </button>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => setShareModalFileId(null)}
                    className="cursor-pointer rounded-[8px] bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover"
                  >
                    {t("shares.create.done")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Access editor modal (admin only) — opened from this collection's own
          kebab or a sub-collection card's kebab (accessTargetId tracks which).
          Rendered as a plain top-level fixed overlay, same as the lightbox
          above — not nested inside any dam-glass card, so no portal is needed
          here (unlike the collection-actions/CollectionTreePicker dropdowns,
          which live inside such a card and must escape its backdrop-filter
          stacking context). Stage 88: grants are valid at any depth and
          cascade downward, so every collection — root or not — gets the same
          editable checkbox form; a tenant with no grant of its own here but
          reachable via an ancestor's grant is shown as "(also via X)" for
          context, never as a reason to disable editing. */}
      {accessTargetId && (
        <>
          <div className="fixed inset-0 z-40 bg-ink/40" onClick={closeAccessModal} />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-xl">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-[18px] font-bold text-ink">{t("collections.access.menuLabel")}</h2>
                <button
                  onClick={closeAccessModal}
                  aria-label={t("common.close")}
                  className="cursor-pointer rounded p-1 text-slate hover:bg-mist"
                >
                  ✕
                </button>
              </div>

              {accessLoading && <p className="text-sm text-slate">{t("common.loading")}</p>}

              {!accessLoading && !accessData && accessError && (
                <p className="text-sm text-red-600 dark:text-red-400">{accessError}</p>
              )}

              {!accessLoading && accessData && (
                <>
                  <p className="mb-3 text-[13px] font-medium text-slate">{t("common.grantAccessTo")}</p>
                  <div className="mb-5 flex flex-col gap-2.5">
                    {accessData.companies.map((c) => (
                      <label key={c.id} className="flex cursor-pointer items-start gap-1.5 text-sm text-ink">
                        <input
                          type="checkbox"
                          checked={accessSelected.has(c.id)}
                          onChange={() => toggleAccessTenant(c.id)}
                          disabled={accessSaving}
                          className="mt-0.5"
                        />
                        <span>
                          {c.name}
                          {c.inheritedFrom && (
                            <span className="ml-1.5 text-xs text-slate">
                              {t("collections.access.inheritedFrom", { name: c.inheritedFrom.name })}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                  {accessError && (
                    <p className="mb-3 text-sm text-red-600 dark:text-red-400">{accessError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={closeAccessModal}
                      disabled={accessSaving}
                      className="h-10 cursor-pointer rounded-[10px] border border-line px-4 text-sm font-medium text-ink hover:bg-mist disabled:opacity-50"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveAccess}
                      disabled={accessSaving}
                      className="h-10 cursor-pointer rounded-[10px] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
                    >
                      {accessSaving ? t("common.saving") : t("common.save")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Upload progress / summary + import status — small frosted strip below the top bar */}
      {showStatusStrip && (
        <div className="dam-glass-light mb-4 rounded-[10px] px-4 py-2.5 text-sm">
          {uploadStatus === "uploading" && uploadProgress && (
            <p className="truncate text-slate">
              {t("media.upload.progress", {
                current: uploadProgress.current,
                total: uploadProgress.total,
                filename: uploadProgress.filename,
              })}
            </p>
          )}
          {uploadStatus === "done" && uploadSummary && (
            <div>
              <span className="text-green-600 dark:text-green-400">
                {t("media.upload.summary", { count: uploadSummary.succeeded })}
                {uploadSummary.failed.length > 0 &&
                  t("common.listSeparator") + t("media.upload.failedClause", { count: uploadSummary.failed.length })}
              </span>
              {uploadSummary.failed.length > 0 && (
                <ul className="mt-1 list-disc list-inside text-red-500 dark:text-red-400 text-xs">
                  {uploadSummary.failed.map((name) => (
                    <li key={name} className="truncate">{name}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {importStatus === "importing" && (
            <p className="text-slate">{t("media.import.inProgress")}</p>
          )}
          {importError && <p className="text-red-600 dark:text-red-400">{importError}</p>}
        </div>
      )}

      {deleteCollectionError && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400">{deleteCollectionError}</p>
      )}
      {coverUploadStatus === "done" && (
        <p className="mb-4 text-sm text-green-600 dark:text-green-400">{t("collections.cover.saved")}</p>
      )}
      {coverUploadStatus === "error" && coverUploadError && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400">{coverUploadError}</p>
      )}

      {/* Sub-collections */}
      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">
            {t("common.subcollections")}
          </h2>
          {children.length > 0 && (
            <Select
              value={sortFilter}
              onChange={handleSortChange}
              ariaLabel={t("collections.subcollections.sortAriaLabel")}
              options={[
                { value: "default", label: t("common.sort.default") },
                { value: "name_asc", label: t("common.sort.nameAsc") },
                { value: "name_desc", label: t("common.sort.nameDesc") },
              ]}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          )}
        </div>
        {loadError && (
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        )}
        {!loadError && children.length === 0 && (
          <p className="text-sm text-slate">
            {t("collections.states.noSubcollections")}
          </p>
        )}
        {children.length > 0 && view === "grid" && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {children.map((c) => (
              /*
               * Card is a relative div so the kebab button can be absolutely
               * positioned without being inside the <Link>, which would trigger
               * navigation on click. overflow-hidden is on the thumbnail only
               * so the kebab dropdown can extend outside the card.
               */
              <div
                key={c.id}
                className={`dam-glass relative overflow-hidden rounded-[13px] shadow-[0_8px_24px_rgba(0,46,92,0.10)] transition-all hover:-translate-y-0.5 hover:shadow-lg ${
                  // dam-glass's backdrop-filter makes this card its own stacking context, which
                  // caps its internal kebab dropdown (z-30) below the page's outside-click
                  // backdrop (z-10, a page-level sibling) unless the card itself is raised above
                  // that backdrop while its menu is open.
                  openChildMenuId === c.id ? "z-20" : ""
                }`}
              >
                <Link href={`/collections/${c.id}`} className="block">
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
                    <p className="truncate text-[13px] font-medium text-ink">{c.name}</p>
                  </div>
                </Link>

                {/* Sub-collection kebab — admin, or an editor granted
                    rename_collection (Stage 108); Access/Delete stay
                    admin-only, gated inside. Outside <Link> so it never navigates */}
                {(canAdmin || myPerms.rename_collection) && (
                  <div className="absolute right-2 top-2 z-20">
                    <button
                      onClick={() => {
                        setColKebabOpen(false);
                        setOpenMenuId(null);
                        setImportPopoverOpen(false);
                        setBreadcrumbOverflowOpen(false);
                        setOpenChildMenuId(openChildMenuId === c.id ? null : c.id);
                      }}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/70 text-ink shadow backdrop-blur-sm hover:bg-white/90 dark:bg-black/40 dark:hover:bg-black/60"
                      aria-label={t("collections.kebab.collectionActions")}
                    >
                      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <circle cx="10" cy="4" r="1.5" />
                        <circle cx="10" cy="10" r="1.5" />
                        <circle cx="10" cy="16" r="1.5" />
                      </svg>
                    </button>
                    {openChildMenuId === c.id && (
                      <div className="absolute right-0 top-8 z-30 w-48 rounded-[10px] border border-line bg-card py-1 shadow-lg">
                        {(canAdmin || myPerms.rename_collection) && (
                          <button
                            onClick={() => { setOpenChildMenuId(null); handleRenameChild(c.id, c.name); }}
                            disabled={renamingChildId === c.id}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                          >
                            {renamingChildId === c.id ? t("common.renaming") : t("common.rename")}
                          </button>
                        )}
                        {canAdmin && (
                          <button
                            onClick={() => { setOpenChildMenuId(null); openAccessModal(c.id); }}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                          >
                            {t("collections.access.menuLabel")}
                          </button>
                        )}
                        {canAdmin && (
                          <button
                            onClick={() => { setOpenChildMenuId(null); handleDeleteChild(c.id); }}
                            disabled={deletingChildId === c.id}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                          >
                            {deletingChildId === c.id ? t("common.deleting") : t("collections.kebab.deleteCollection")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {deleteChildErrors[c.id] && (
                  <p className="px-3.5 pb-2 text-xs text-red-600 dark:text-red-400">{deleteChildErrors[c.id]}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {children.length > 0 && view === "list" && (
          /*
           * No overflow-hidden here (unlike the grid cards) — clipping would cut off a
           * row's kebab dropdown when it renders near the panel's bottom edge. The panel
           * still gets backdrop-filter from dam-glass, so it's the stacking-context
           * boundary the dropdown needs to escape (same gotcha as the grid kebabs); when
           * a row's menu is open the whole panel is raised to z-20 (above the page-level
           * z-10 outside-click backdrop) since the backdrop-filter context lives on this
           * wrapper, not on individual rows.
           */
          <div
            className={`dam-glass rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)] ${
              openChildMenuId !== null ? "relative z-20" : ""
            }`}
          >
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
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {children.map((c) => (
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
                      {deleteChildErrors[c.id] && (
                        <p className="text-xs text-red-600 dark:text-red-400">{deleteChildErrors[c.id]}</p>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-sm text-slate">{c.subcollection_count}</td>
                    <td className="px-5 py-2.5 text-sm text-slate">{c.file_count}</td>
                    <td className="px-5 py-2.5 text-right">
                      {/* Sub-collection kebab — admin, or an editor granted
                          rename_collection (Stage 108); Access/Delete stay
                          admin-only, gated inside. stopPropagation so it
                          never triggers row navigation */}
                      {(canAdmin || myPerms.rename_collection) && (
                        <div
                          className="relative inline-block"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => {
                              setColKebabOpen(false);
                              setOpenMenuId(null);
                              setImportPopoverOpen(false);
                              setBreadcrumbOverflowOpen(false);
                              setOpenChildMenuId(openChildMenuId === c.id ? null : c.id);
                            }}
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-slate hover:bg-mist"
                            aria-label={t("collections.kebab.collectionActions")}
                          >
                            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                              <circle cx="10" cy="4" r="1.5" />
                              <circle cx="10" cy="10" r="1.5" />
                              <circle cx="10" cy="16" r="1.5" />
                            </svg>
                          </button>
                          {openChildMenuId === c.id && (
                            <div className="absolute right-0 top-8 z-30 w-48 rounded-[10px] border border-line bg-card py-1 text-left shadow-lg">
                              {(canAdmin || myPerms.rename_collection) && (
                                <button
                                  onClick={() => { setOpenChildMenuId(null); handleRenameChild(c.id, c.name); }}
                                  disabled={renamingChildId === c.id}
                                  className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                                >
                                  {renamingChildId === c.id ? t("common.renaming") : t("common.rename")}
                                </button>
                              )}
                              {canAdmin && (
                                <button
                                  onClick={() => { setOpenChildMenuId(null); openAccessModal(c.id); }}
                                  className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                                >
                                  {t("collections.access.menuLabel")}
                                </button>
                              )}
                              {canAdmin && (
                                <button
                                  onClick={() => { setOpenChildMenuId(null); handleDeleteChild(c.id); }}
                                  disabled={deletingChildId === c.id}
                                  className="w-full cursor-pointer px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                                >
                                  {deletingChildId === c.id ? t("common.deleting") : t("collections.kebab.deleteCollection")}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pager — shared by grid and list views; both render the same page of `children`.
            Independent of the Files pager below: its own state (subPage/subPageSize/subTotal). */}
        {!loadError && subTotal > 0 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate">
              {t("media.pagination.showing", { start: subRangeStart, end: subRangeEnd, total: subTotal })}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <nav className="flex items-center gap-1" aria-label={t("collections.subcollections.paginationAriaLabel")}>
                <button
                  onClick={() => setSubPage((p) => Math.max(1, p - 1))}
                  disabled={subPage <= 1}
                  className="cursor-pointer rounded-[8px] border border-line bg-white/80 dark:bg-white/10 px-2.5 py-1.5 text-sm text-ink hover:bg-card disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("media.pagination.prev")}
                </button>
                {getPageNumbers(subPage, subTotalPages).map((p, i) =>
                  p === "ellipsis" ? (
                    <span key={`ellipsis-${i}`} className="px-2 text-sm text-slate">
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setSubPage(p)}
                      aria-current={p === subPage ? "page" : undefined}
                      className={`cursor-pointer rounded-[8px] px-3 py-1.5 text-sm ${
                        p === subPage
                          ? "bg-brand font-semibold text-white"
                          : "border border-line bg-white/80 dark:bg-white/10 text-ink hover:bg-card"
                      }`}
                    >
                      {p}
                    </button>
                  )
                )}
                <button
                  onClick={() => setSubPage((p) => Math.min(subTotalPages, p + 1))}
                  disabled={subPage >= subTotalPages}
                  className="cursor-pointer rounded-[8px] border border-line bg-white/80 dark:bg-white/10 px-2.5 py-1.5 text-sm text-ink hover:bg-card disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("media.pagination.next")}
                </button>
              </nav>

              <label className="flex items-center gap-2 text-sm text-slate">
                {t("media.pagination.perPage")}
                <Select
                  ariaLabel={t("collections.subcollections.perPageAriaLabel")}
                  value={String(subPageSize)}
                  onChange={(v) => handleSubPageSizeChange(Number(v))}
                  options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </label>
            </div>
          </div>
        )}
      </section>

      {/* Files */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">{t("common.files")}</h2>
          {!selectMode && files.length > 0 && (
            <button
              onClick={() => { setSelectMode(true); setZipNote(null); }}
              className="cursor-pointer rounded-[8px] border border-line bg-white/80 dark:bg-white/10 px-3 py-1.5 text-sm text-ink hover:bg-card"
            >
              {t("common.select")}
            </button>
          )}
        </div>

        {/* Selection bar — visible in select mode */}
        {selectMode && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[12px] border border-selected-ring bg-surface-tint/75 px-4 py-3 backdrop-blur-md">
            <span className="text-sm font-medium text-brand">
              {t("media.select.count", { count: selectedIds.size })}
            </span>
            <button
              onClick={toggleSelectAll}
              disabled={zipStatus === "zipping" || bulkActionStatus !== "idle" || files.length === 0}
              className="cursor-pointer text-sm font-medium text-brand underline hover:text-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {selectedIds.size === files.length && files.length > 0 ? t("media.select.deselectAll") : t("media.select.selectAllPage")}
            </button>
            {zipStatus === "zipping" && zipProgress && (
              <span className="text-sm text-brand">
                {t("media.select.zipping", { current: zipProgress.current, total: zipProgress.total })}
              </span>
            )}
            {bulkActionStatus === "removing" && bulkActionProgress && (
              <span className="text-sm text-brand">
                {t("collections.bulk.removing", { current: bulkActionProgress.current, total: bulkActionProgress.total })}
              </span>
            )}
            {bulkActionStatus === "deleting" && bulkActionProgress && (
              <span className="text-sm text-brand">
                {t("media.select.deleting", { current: bulkActionProgress.current, total: bulkActionProgress.total })}
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {myPerms.download && (
                <button
                  onClick={handleBulkDownload}
                  disabled={selectedIds.size === 0 || zipStatus === "zipping"}
                  className="cursor-pointer rounded-[8px] bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                >
                  {zipStatus === "zipping" ? t("media.select.preparingDownload") : t("collections.bulk.downloadSelected")}
                </button>
              )}
              {(canAdmin || myPerms.remove_from_collection) && (
                <button
                  onClick={handleBulkRemove}
                  disabled={selectedIds.size === 0 || zipStatus === "zipping" || bulkActionStatus !== "idle"}
                  className="cursor-pointer rounded-[8px] border border-line bg-white/90 dark:bg-white/10 px-3 py-1.5 text-sm text-ink hover:bg-card disabled:opacity-50"
                >
                  {bulkActionStatus === "removing" ? t("collections.remove.removing") : t("collections.remove.action")}
                </button>
              )}
              {(canAdmin || myPerms.delete_permanently) && (
                <button
                  onClick={handleBulkPermanentDelete}
                  disabled={selectedIds.size === 0 || zipStatus === "zipping" || bulkActionStatus !== "idle"}
                  className="cursor-pointer rounded-[8px] bg-red-600 dark:bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 dark:hover:bg-red-500 disabled:opacity-50"
                >
                  {bulkActionStatus === "deleting" ? t("common.deleting") : t("common.deletePermanently")}
                </button>
              )}
              <button
                onClick={() => {
                  setSelectMode(false);
                  setSelectedIds(new Set());
                  setZipStatus("idle");
                  setZipProgress(null);
                  setBulkActionStatus("idle");
                  setBulkActionProgress(null);
                }}
                disabled={zipStatus === "zipping" || bulkActionStatus !== "idle"}
                className="cursor-pointer rounded-[8px] border border-line bg-white/90 dark:bg-white/10 px-3 py-1.5 text-sm text-ink hover:bg-card disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}

        {/* Note shown after a bulk download if any files were skipped */}
        {zipNote && !selectMode && (
          <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">{zipNote}</p>
        )}
        {/* Summary shown after a bulk remove/delete */}
        {bulkActionSummary && !selectMode && (
          <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">{bulkActionSummary}</p>
        )}

        {filesLoading && <p className="text-sm text-slate">{t("common.loading")}</p>}
        {filesError && (
          <p className="text-sm text-red-600 dark:text-red-400">{filesError}</p>
        )}
        {!filesLoading && !filesError && files.length === 0 && (
          <p className="text-sm text-slate">
            {t("collections.states.noFiles")}
          </p>
        )}
        {files.length > 0 && view === "grid" && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {files.map((f) => (
              /*
               * Card is relative+flex-col so the kebab button can be
               * absolutely positioned over the thumbnail corner, and the
               * body (flex-1) fills remaining height so mt-auto pins the
               * Download button to the card's bottom-right.
               * overflow-hidden is on the thumbnail only (not the card)
               * so the kebab dropdown can extend outside it.
               */
              <div
                key={f.id}
                className={`dam-glass relative flex flex-col overflow-hidden rounded-[13px] shadow-[0_8px_24px_rgba(0,46,92,0.10)] transition-all ${
                  selectMode && selectedIds.has(f.id) ? "ring-2 ring-brand" : ""
                } ${
                  // dam-glass's backdrop-filter makes this card its own stacking context, which
                  // caps its internal kebab dropdown (z-30) below the page's outside-click
                  // backdrop (z-10, a page-level sibling) unless the card itself is raised above
                  // that backdrop while its menu is open.
                  openMenuId === f.id ? "z-20" : ""
                }`}
              >
                {/* Thumbnail */}
                <div
                  className={`relative aspect-[4/3] w-full overflow-hidden ${
                    f.mime_type === "application/pdf" && thumbnailUrls[f.id] ? "bg-white" : "bg-surface-tint"
                  }`}
                >
                  {thumbnailUrls[f.id] ? (
                    <>
                      <img
                        src={thumbnailUrls[f.id]}
                        alt={f.original_filename}
                        className={`h-full w-full cursor-pointer object-cover${
                          f.mime_type === "application/pdf" ? " object-top" : ""
                        }`}
                        onClick={() => {
                          if (selectMode) toggleSelect(f.id);
                          else openLightbox(f);
                        }}
                        onError={() =>
                          setThumbnailUrls((prev) => {
                            const next = { ...prev };
                            delete next[f.id];
                            return next;
                          })
                        }
                      />
                      {f.mime_type.startsWith("video/") && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-black/50">
                            <svg className="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M6 4l10 6-10 6V4z" />
                            </svg>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div
                      className={`flex h-full flex-col items-center justify-center gap-1${selectMode ? " cursor-pointer" : ""}`}
                      onClick={selectMode ? () => toggleSelect(f.id) : undefined}
                    >
                      <FileTypeIcon mimeType={f.mime_type} className="h-8 w-8" />
                      <span className="text-[10px] font-medium uppercase tracking-wide text-slate">
                        {shortTypeLabel(f.mime_type, f.original_filename)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Checkbox overlay — top-left, select mode only */}
                {selectMode && (
                  <div className="absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-white/85 shadow backdrop-blur-sm">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(f.id)}
                      onChange={() => toggleSelect(f.id)}
                      className="h-4 w-4 cursor-pointer rounded border-line accent-brand"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                )}

                {/* Kebab (three-dot) menu — admins see the full menu; canUpload-only users
                    (e.g. Editors) see just "Remove from collection"; a viewer with
                    create_share (Stage 108) sees just "Share"; hidden in select mode */}
                {(canAdmin || canUpload || myPerms.create_share) && !selectMode && (
                  <div className="absolute right-2 top-2 z-20">
                    <button
                      onClick={() => {
                        setColKebabOpen(false);
                        setOpenChildMenuId(null);
                        setImportPopoverOpen(false);
                        setBreadcrumbOverflowOpen(false);
                        setOpenMenuId(openMenuId === f.id ? null : f.id);
                      }}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/70 text-ink shadow backdrop-blur-sm hover:bg-white/90 dark:bg-black/40 dark:hover:bg-black/60"
                      aria-label={t("media.kebab.fileActions")}
                    >
                      {/* Vertical three dots */}
                      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <circle cx="10" cy="4" r="1.5" />
                        <circle cx="10" cy="10" r="1.5" />
                        <circle cx="10" cy="16" r="1.5" />
                      </svg>
                    </button>
                    {openMenuId === f.id && (
                      <div className="absolute right-0 top-8 z-30 w-48 rounded-[10px] border border-line bg-card py-1 shadow-lg">
                        {(canAdmin || myPerms.rename_asset) && (
                          <button
                            onClick={() => { setOpenMenuId(null); handleRenameFile(f.id, f.original_filename); }}
                            disabled={renamingFileIds.has(f.id)}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                          >
                            {renamingFileIds.has(f.id) ? t("common.renaming") : t("common.rename")}
                          </button>
                        )}
                        {(canAdmin || myPerms.edit_metadata) && (
                          <button
                            onClick={() => { setOpenMenuId(null); router.push(`/resources/${f.id}/metadata`); }}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                          >
                            {t("common.editMetadata")}
                          </button>
                        )}
                        {(canAdmin || myPerms.regenerate_thumbnail) && supportsGeneratedThumbnail(f.mime_type) && (
                          <button
                            onClick={() => {
                              setOpenMenuId(null);
                              if (f.thumbnail_storage_key) handleRegenerateThumbnail(f.id);
                              else handleGenerateThumbnail(f.id);
                            }}
                            disabled={generatingThumbIds.has(f.id)}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                          >
                            {generatingThumbIds.has(f.id)
                              ? (f.thumbnail_storage_key ? t("media.kebab.regenerating") : t("media.kebab.generating"))
                              : (f.thumbnail_storage_key ? t("media.kebab.regenerateThumbnail") : t("media.kebab.generateThumbnail"))}
                          </button>
                        )}
                        {(canAdmin || myPerms.remove_from_collection) && (
                          <button
                            onClick={() => { setOpenMenuId(null); handleRemove(f.id); }}
                            disabled={removingIds.has(f.id)}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                          >
                            {removingIds.has(f.id) ? t("collections.remove.removing") : t("collections.remove.action")}
                          </button>
                        )}
                        {(canAdmin || myPerms.delete_permanently) && (
                          <button
                            onClick={() => { setOpenMenuId(null); handlePermanentDelete(f.id); }}
                            disabled={deletingIds.has(f.id)}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                          >
                            {deletingIds.has(f.id) ? t("common.deleting") : t("common.deletePermanently")}
                          </button>
                        )}
                        {myPerms.create_share && (
                          <button
                            onClick={() => { setOpenMenuId(null); openShareModal(f.id); }}
                            className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                          >
                            {t("collections.share.menuItem")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Card body */}
                <div className="flex flex-1 flex-col p-3.5">
                  <p
                    className="truncate text-sm font-medium text-ink"
                    title={f.original_filename}
                  >
                    {f.original_filename}
                  </p>
                  <p className="mt-0.5 text-xs text-slate">
                    {shortTypeLabel(f.mime_type, f.original_filename)} · {formatBytes(f.size_bytes)}
                  </p>

                  {/* Description — editable for admins, read-only for others */}
                  <div className="mt-2 min-h-[2rem]">
                    {canAdmin && editingDescId === f.id ? (
                      <div className="flex flex-col gap-1.5">
                        <textarea
                          autoFocus
                          value={draftDesc}
                          onChange={(e) => setDraftDesc(e.target.value)}
                          disabled={savingDescIds.has(f.id)}
                          rows={3}
                          className="w-full resize-none rounded-[8px] border border-line px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-50"
                        />
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => handleSaveDescription(f.id)}
                            disabled={savingDescIds.has(f.id)}
                            className="cursor-pointer rounded-[6px] bg-brand px-2 py-0.5 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                          >
                            {savingDescIds.has(f.id) ? t("common.saving") : t("common.save")}
                          </button>
                          <button
                            onClick={() => { setEditingDescId(null); setDescErrors((prev) => ({ ...prev, [f.id]: "" })); }}
                            disabled={savingDescIds.has(f.id)}
                            className="cursor-pointer rounded-[6px] border border-line px-2 py-0.5 text-xs text-slate hover:bg-mist disabled:opacity-50"
                          >
                            {t("common.cancel")}
                          </button>
                        </div>
                        {descErrors[f.id] && (
                          <p className="text-xs text-red-500 dark:text-red-400">{descErrors[f.id]}</p>
                        )}
                      </div>
                    ) : canAdmin ? (
                      <button
                        onClick={() => { setEditingDescId(f.id); setDraftDesc(f.description ?? ""); }}
                        className="w-full cursor-pointer text-left"
                      >
                        {f.description ? (
                          <p className="text-xs leading-relaxed text-slate hover:text-ink">{f.description}</p>
                        ) : (
                          <p className="text-xs italic text-border-soft hover:text-slate">{t("collections.description.addPlaceholder")}</p>
                        )}
                      </button>
                    ) : (
                      f.description && (
                        <p className="text-xs leading-relaxed text-slate">{f.description}</p>
                      )
                    )}
                  </div>

                  {/* Details — opens the metadata drawer. Stage 108:
                      'view_metadata' is viewer-configurable (always true for
                      every other role via the myPerms bundle). */}
                  {myPerms.view_metadata && (
                    <button
                      onClick={() => setDetailsResourceId(f.id)}
                      className="mt-2 flex w-fit cursor-pointer items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
                    >
                      <InfoIcon />
                      {t("common.details")}
                    </button>
                  )}

                  {/* Inline errors */}
                  {downloadErrors[f.id] && (
                    <p className="text-xs text-red-500 dark:text-red-400">{downloadErrors[f.id]}</p>
                  )}
                  {removeErrors[f.id] && (
                    <p className="text-xs text-red-500 dark:text-red-400">{removeErrors[f.id]}</p>
                  )}
                  {deleteErrors[f.id] && (
                    <p className="text-xs text-red-500 dark:text-red-400">{deleteErrors[f.id]}</p>
                  )}
                  {renameFileErrors[f.id] && (
                    <p className="text-xs text-red-500 dark:text-red-400">{renameFileErrors[f.id]}</p>
                  )}
                  {thumbnailErrors[f.id] && (
                    <p className="text-xs text-red-500 dark:text-red-400">{thumbnailErrors[f.id]}</p>
                  )}

                  {/* Download — pinned to bottom-right. Stage 108: 'download' is
                      viewer-configurable (always true for every other role via
                      the myPerms bundle), so this is the one place a bare
                      permission check replaces what used to be unconditional. */}
                  {myPerms.download && (
                    <div className="mt-auto flex justify-end pt-2">
                      <button
                        onClick={() => handleDownload(f.id, f.original_filename)}
                        disabled={downloadingIds.has(f.id)}
                        className="cursor-pointer rounded-[8px] bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                      >
                        {downloadingIds.has(f.id) ? t("collections.download.inProgress") : t("common.download")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {files.length > 0 && view === "list" && (
          /* No overflow-hidden — see the sub-collections list panel comment above for why;
             same reasoning applies here (kebab dropdown clipping + backdrop-filter stacking
             context needing to be raised as a whole, not per-row). */
          <div
            className={`dam-glass rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)] ${
              openMenuId !== null ? "relative z-20" : ""
            }`}
          >
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-line/70">
                  {selectMode && <th className="w-10 px-5 py-3" />}
                  <th className="w-14 px-5 py-3" />
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                    {t("media.list.headerFilename")}
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                    {t("common.type")}
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                    {t("media.list.headerSize")}
                  </th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const rowError =
                    downloadErrors[f.id] || removeErrors[f.id] || deleteErrors[f.id] ||
                    renameFileErrors[f.id] || thumbnailErrors[f.id];
                  return (
                    <tr
                      key={f.id}
                      className={`border-b border-surface-tint-2 transition-colors last:border-b-0 ${
                        selectMode && selectedIds.has(f.id) ? "bg-surface-tint/60" : "hover:bg-white/40 dark:hover:bg-white/5"
                      }`}
                    >
                      {selectMode && (
                        <td className="px-5 py-2.5">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(f.id)}
                            onChange={() => toggleSelect(f.id)}
                            className="h-4 w-4 cursor-pointer rounded border-line accent-brand"
                          />
                        </td>
                      )}
                      <td className="px-5 py-2.5">
                        <div
                          className={`relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[8px] ${
                            f.mime_type === "application/pdf" && thumbnailUrls[f.id] ? "bg-white" : "bg-surface-tint"
                          }`}
                        >
                          {thumbnailUrls[f.id] ? (
                            <>
                              <img
                                src={thumbnailUrls[f.id]}
                                alt={f.original_filename}
                                className={`h-full w-full cursor-pointer object-cover${
                                  f.mime_type === "application/pdf" ? " object-top" : ""
                                }`}
                                onClick={() => {
                                  if (selectMode) toggleSelect(f.id);
                                  else openLightbox(f);
                                }}
                              />
                              {f.mime_type.startsWith("video/") && (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                  <svg className="h-3 w-3 text-white drop-shadow" viewBox="0 0 20 20" fill="currentColor">
                                    <path d="M6 4l10 6-10 6V4z" />
                                  </svg>
                                </div>
                              )}
                            </>
                          ) : (
                            <span
                              className={selectMode ? "cursor-pointer" : ""}
                              onClick={selectMode ? () => toggleSelect(f.id) : undefined}
                            >
                              <FileTypeIcon mimeType={f.mime_type} className="h-5 w-5" />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-2.5">
                        <span className="text-sm font-medium text-ink" title={f.original_filename}>
                          {f.original_filename}
                        </span>
                        {rowError && <p className="text-xs text-red-500 dark:text-red-400">{rowError}</p>}
                      </td>
                      <td className="px-5 py-2.5 text-sm text-slate">{shortTypeLabel(f.mime_type, f.original_filename)}</td>
                      <td className="px-5 py-2.5 text-sm text-slate">{formatBytes(f.size_bytes)}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center justify-end gap-2">
                          {myPerms.view_metadata && (
                            <button
                              onClick={() => setDetailsResourceId(f.id)}
                              className="flex cursor-pointer items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
                            >
                              <InfoIcon />
                              {t("common.details")}
                            </button>
                          )}
                          {myPerms.download && (
                            <button
                              onClick={() => handleDownload(f.id, f.original_filename)}
                              disabled={downloadingIds.has(f.id)}
                              className="cursor-pointer rounded-[8px] bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                            >
                              {downloadingIds.has(f.id) ? t("collections.download.inProgress") : t("common.download")}
                            </button>
                          )}
                          {(canAdmin || canUpload || myPerms.create_share) && !selectMode && (
                            <div className="relative inline-block">
                              <button
                                onClick={() => {
                                  setColKebabOpen(false);
                                  setOpenChildMenuId(null);
                                  setImportPopoverOpen(false);
                                  setBreadcrumbOverflowOpen(false);
                                  setOpenMenuId(openMenuId === f.id ? null : f.id);
                                }}
                                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-slate hover:bg-mist"
                                aria-label={t("media.kebab.fileActions")}
                              >
                                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                  <circle cx="10" cy="4" r="1.5" />
                                  <circle cx="10" cy="10" r="1.5" />
                                  <circle cx="10" cy="16" r="1.5" />
                                </svg>
                              </button>
                              {openMenuId === f.id && (
                                <div className="absolute right-0 top-8 z-30 w-48 rounded-[10px] border border-line bg-card py-1 text-left shadow-lg">
                                  {(canAdmin || myPerms.rename_asset) && (
                                    <button
                                      onClick={() => { setOpenMenuId(null); handleRenameFile(f.id, f.original_filename); }}
                                      disabled={renamingFileIds.has(f.id)}
                                      className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                                    >
                                      {renamingFileIds.has(f.id) ? t("common.renaming") : t("common.rename")}
                                    </button>
                                  )}
                                  {(canAdmin || myPerms.edit_metadata) && (
                                    <button
                                      onClick={() => { setOpenMenuId(null); router.push(`/resources/${f.id}/metadata`); }}
                                      className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                                    >
                                      {t("common.editMetadata")}
                                    </button>
                                  )}
                                  {(canAdmin || myPerms.regenerate_thumbnail) && supportsGeneratedThumbnail(f.mime_type) && (
                                    <button
                                      onClick={() => {
                                        setOpenMenuId(null);
                                        if (f.thumbnail_storage_key) handleRegenerateThumbnail(f.id);
                                        else handleGenerateThumbnail(f.id);
                                      }}
                                      disabled={generatingThumbIds.has(f.id)}
                                      className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                                    >
                                      {generatingThumbIds.has(f.id)
                                        ? (f.thumbnail_storage_key ? t("media.kebab.regenerating") : t("media.kebab.generating"))
                                        : (f.thumbnail_storage_key ? t("media.kebab.regenerateThumbnail") : t("media.kebab.generateThumbnail"))}
                                    </button>
                                  )}
                                  {(canAdmin || myPerms.remove_from_collection) && (
                                    <button
                                      onClick={() => { setOpenMenuId(null); handleRemove(f.id); }}
                                      disabled={removingIds.has(f.id)}
                                      className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                                    >
                                      {removingIds.has(f.id) ? t("collections.remove.removing") : t("collections.remove.action")}
                                    </button>
                                  )}
                                  {(canAdmin || myPerms.delete_permanently) && (
                                    <button
                                      onClick={() => { setOpenMenuId(null); handlePermanentDelete(f.id); }}
                                      disabled={deletingIds.has(f.id)}
                                      className="w-full cursor-pointer px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                                    >
                                      {deletingIds.has(f.id) ? t("common.deleting") : t("common.deletePermanently")}
                                    </button>
                                  )}
                                  {myPerms.create_share && (
                                    <button
                                      onClick={() => { setOpenMenuId(null); openShareModal(f.id); }}
                                      className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                                    >
                                      {t("collections.share.menuItem")}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pager — shared by grid and list views; both render the same page of `files` */}
        {!filesError && total > 0 && (
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
                  ariaLabel={t("collections.files.perPageAriaLabel")}
                  value={String(pageSize)}
                  onChange={(v) => handlePageSizeChange(Number(v))}
                  options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </label>
            </div>
          </div>
        )}
      </section>

      <MetadataDrawer
        resourceId={detailsResourceId}
        filename={detailsFile?.original_filename ?? ""}
        meta={detailsFile ? `${shortTypeLabel(detailsFile.mime_type, detailsFile.original_filename)} · ${formatBytes(detailsFile.size_bytes)}` : ""}
        canEdit={canAdmin || myPerms.edit_metadata}
        onClose={() => setDetailsResourceId(null)}
      />
    </AppShell>
  );
}
