"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import JSZip from "jszip";
import AppShell from "@/components/AppShell";
import MetadataDrawer from "@/components/MetadataDrawer";
import CollectionTreePicker from "@/components/CollectionTreePicker";
import Select from "@/components/Select";
import ViewToggle, { ViewMode } from "@/components/ViewToggle";
import FileTypeIcon from "@/components/FileTypeIcon";
import { shortTypeLabel } from "@/lib/fileTypes";
import { useTranslation } from "@/lib/i18n";

const VIEW_STORAGE_KEY = "dam:view:media";
const SORT_STORAGE_KEY = "dam:sort:media";
const VALID_SORTS = ["newest", "oldest", "largest", "smallest", "name_asc", "name_desc"];
const PAGE_SIZE_STORAGE_KEY = "dam:pagesize:media";
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

interface MediaFile {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  description: string | null;
  created_at: string;
  thumbnail_storage_key: string | null;
  collections: { id: string; name: string }[];
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

function InfoIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v4.5M10 6.75h.01" strokeLinecap="round" />
    </svg>
  );
}

export default function AdminMediaPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  // Gates the "Unassigned only" checkbox — a tenant admin's list can never
  // include an unassigned resource (an orphan is in no tenant's scope by
  // definition, see GET /api/media), so the checkbox is hidden for them
  // rather than left visible and always returning zero results.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  // Filter state — all drive the fetch effect
  const [typeFilter, setTypeFilter] = useState("");
  const [qInput, setQInput] = useState("");
  const [sortFilter, setSortFilter] = useState("newest");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [collectionFilter, setCollectionFilter] = useState(""); // "" = All collections

  // Pagination state — page is 1-based and never persisted; pageSize is.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);

  // Results
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [view, setView] = useState<ViewMode>("grid");

  // Kebab menu / delete
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [renamingIds, setRenamingIds] = useState<Set<string>>(new Set());
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});

  // Video thumbnail generation
  const [generatingThumbIds, setGeneratingThumbIds] = useState<Set<string>>(new Set());
  const [thumbnailErrors, setThumbnailErrors] = useState<Record<string, string>>({});

  // Add to collection
  const [assigningIds, setAssigningIds] = useState<Set<string>>(new Set());
  const [assignErrors, setAssignErrors] = useState<Record<string, string>>({});

  // Upload — for a super admin, unchanged: creates an Unassigned file when no
  // collection is picked. For a tenant admin, a target collection is now
  // required (Stage 102): an Unassigned resource sits outside every
  // tenant's reach (see GET /api/media's Stage 101 scoping), so the upload
  // would otherwise silently succeed into a file the uploader can never see
  // again. Enforced both here (button disabled, see uploadTargetCollectionId
  // below) and server-side in POST /api/upload/complete.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "done">("idle");
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; filename: string } | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{ succeeded: number; failed: string[] } | null>(null);

  // Import from URL — same collection requirement as Upload for a tenant
  // admin (see uploadTargetCollectionId below); a super admin still creates
  // an Unassigned file when none is picked, unchanged.
  const [importUrl, setImportUrl] = useState("");
  const [importStatus, setImportStatus] = useState<"idle" | "importing">("idle");
  const [importError, setImportError] = useState<string | null>(null);
  // Presentational only — toggles the top-bar "Import URL" popover
  const [importPopoverOpen, setImportPopoverOpen] = useState(false);

  // Shared target-collection picker for Upload + Import URL — rendered only
  // for a non-super-admin (a super admin's controls stay exactly as they
  // were: no picker, optional collection, unchanged). One shared value since
  // both actions sit in the same top-bar area and there's no reason to pick
  // a collection twice.
  const [uploadTargetCollectionId, setUploadTargetCollectionId] = useState<string | null>(null);

  // Select mode / bulk actions
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<"idle" | "adding" | "deleting" | "zipping">("idle");
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);

  // Thumbnails — blob URLs keyed by file id
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  // All created blob URLs; revoked together on unmount
  const createdObjectUrls = useRef<string[]>([]);
  // Tracks which file ids have had a thumbnail fetch started (avoids duplicate requests)
  const loadedThumbIdsRef = useRef<Set<string>>(new Set());

  // Lightbox
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState("");

  // Metadata drawer — one asset at a time; whole page is admin-gated
  const [detailsResourceId, setDetailsResourceId] = useState<string | null>(null);

  // Stale-response discard
  const fetchCounterRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auth check on mount
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }
    const payload = parseToken(token);
    // The media library is now tenant-scoped (GET /api/media, as of this
    // pass) — a tenant admin sees only resources their tenant can reach,
    // same tier as every other widened collection/resource/share surface.
    if (!payload?.canAdmin) { setNotAdmin(true); setAuthorized(true); return; }
    setIsSuperAdmin(payload?.roleName === "super_admin");
    setAuthorized(true);
  }, [router]);

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
      // localStorage unavailable — keep the 'newest' default
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

  // Not persisted — collection filter is a transient query, not a display
  // preference (unlike view/sort/pageSize, which use localStorage above).
  // Mutually exclusive with "Unassigned only": selecting a collection clears
  // it; the checkbox is disabled while a collection is selected so the
  // reverse direction can't happen either.
  function handleCollectionFilterChange(next: string) {
    setCollectionFilter(next);
    if (next) setUnassignedOnly(false);
    setPage(1);
  }

  // Selection is per-page: leaving the page you selected on drops the selection
  // and exits select mode entirely (there's nothing left selected to act on).
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [page]);

  // Fetches the media list with the current filters. Shared by the debounced
  // filter-change effect and by bulk actions that need an immediate refetch.
  async function fetchMedia() {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    const stamp = ++fetchCounterRef.current;
    setLoading(true);
    setFetchError(null);

    const params = new URLSearchParams();
    if (typeFilter) params.set("type", typeFilter);
    if (qInput.trim()) params.set("q", qInput.trim());
    params.set("sort", sortFilter);
    if (unassignedOnly) params.set("unassigned", "true");
    if (collectionFilter) params.set("collectionId", collectionFilter);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    try {
      const res = await fetch(`/api/media?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (stamp !== fetchCounterRef.current) return;
      if (!res.ok) throw new Error(t("media.error.loadFailed", { status: res.status }));
      const data = (await res.json()) as { files: MediaFile[]; total: number; page: number; pageSize: number };
      if (stamp !== fetchCounterRef.current) return;
      setFiles(data.files);
      setTotal(data.total);
      // The server clamps an out-of-range page to the last valid page — mirror
      // that back into state so the pager reflects where the data actually is
      // (this is also what makes "delete the last item on the last page" step back).
      if (data.page !== page) setPage(data.page);
    } catch (err) {
      if (stamp !== fetchCounterRef.current) return;
      setFetchError(err instanceof Error ? err.message : t("media.error.loadFailedGeneric"));
    } finally {
      if (stamp === fetchCounterRef.current) setLoading(false);
    }
  }

  // Fetch media whenever any filter, sort, or pagination value changes
  // (debounced 300 ms; stale responses discarded).
  useEffect(() => {
    if (!authorized || notAdmin) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { fetchMedia(); }, 300);
  }, [typeFilter, qInput, sortFilter, unassignedOnly, collectionFilter, page, pageSize, authorized, notAdmin, router]);

  // Revoke all blob URLs on unmount
  useEffect(() => {
    const urls = createdObjectUrls.current;
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  // Load thumbnail blob URLs for image files, and for video files that
  // already have a generated thumbnail_storage_key, whenever the file list changes.
  useEffect(() => {
    if (!authorized || files.length === 0) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    for (const f of files) {
      // Any file with a generated thumbnail (video, PDF, or now image)
      // fetches that small derivative via /api/cover?key= — never the full
      // original. An image with no thumbnail yet falls back to the full
      // original via /api/download/[id] so its card isn't blank while
      // generation is in flight (or hasn't been triggered at all, for
      // pre-rollout files) — deliberately *not* dedup-guarded, unlike the
      // has-thumbnail case, so the effect naturally re-fetches and upgrades
      // to the small thumbnail once one appears on a later file-list refresh
      // (same pattern this file already used for thumbnail-less videos).
      const hasThumb = !!f.thumbnail_storage_key;
      const isImage = f.mime_type.startsWith("image/");
      if (!hasThumb && !isImage) continue;
      if (hasThumb) {
        if (loadedThumbIdsRef.current.has(f.id)) continue;
        loadedThumbIdsRef.current.add(f.id);
      }

      (async () => {
        try {
          const res = hasThumb
            ? await fetch(`/api/cover?key=${encodeURIComponent(f.thumbnail_storage_key!)}`, {
                headers: { Authorization: `Bearer ${token}` },
              })
            : await fetch(`/api/download/${f.id}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
          if (!res.ok) return;
          const body = await res.json();
          const presignedUrl = hasThumb ? body.url : body.downloadUrl;
          const imgRes = await fetch(presignedUrl);
          if (!imgRes.ok) return;
          const blob = await imgRes.blob();
          const objectUrl = URL.createObjectURL(blob);
          createdObjectUrls.current.push(objectUrl);
          setThumbnailUrls((prev) => ({ ...prev, [f.id]: objectUrl }));
        } catch {
          // leave absent — type label shown instead
        }
      })();
    }
  }, [files, authorized]);

  // Close lightbox on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxUrl(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function handleUpload() {
    if (selectedFiles.length === 0) return;
    // Defensive — the Upload button is already disabled without a selection
    // for a non-super-admin (see uploadTargetCollectionId), so this should
    // never actually be reachable; it's here only so a tenant admin can
    // never silently create an Unassigned file through this handler.
    if (!isSuperAdmin && !uploadTargetCollectionId) return;
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

        // Step 3: register in DB. uploadTargetCollectionId is required (and
        // enforced server-side) for a tenant admin; a super admin who
        // leaves it unset still creates an Unassigned file, unchanged.
        const completeRes = await fetch("/api/upload/complete", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            key,
            filename: file.name,
            contentType: file.type,
            size: file.size,
            ...(uploadTargetCollectionId ? { collectionId: uploadTargetCollectionId } : {}),
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

    if (succeeded > 0) await fetchMedia();

    // Route the newly-created assets into the "Save and next" metadata
    // workflow, one at a time. Failed uploads never got a resource id, so
    // they're naturally excluded from the queue.
    if (uploadedIds.length > 0) {
      const batch = uploadedIds.join(",");
      router.push(
        `/resources/${uploadedIds[0]}/metadata?batch=${encodeURIComponent(batch)}&i=0&return=${encodeURIComponent("/admin/media")}`
      );
    }
  }

  async function handleImportFromUrl() {
    const url = importUrl.trim();
    if (!url) { setImportError(t("media.import.enterUrl")); return; }
    // Defensive — the Import button is already disabled without a selection
    // for a non-super-admin (see uploadTargetCollectionId), same reasoning
    // as handleUpload above.
    if (!isSuperAdmin && !uploadTargetCollectionId) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setImportStatus("importing");
    setImportError(null);

    try {
      const res = await fetch("/api/upload/from-url", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          ...(uploadTargetCollectionId ? { collectionId: uploadTargetCollectionId } : {}),
        }),
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
      await fetchMedia();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : t("media.import.genericError"));
    } finally {
      setImportStatus("idle");
    }
  }

  async function handlePermanentDelete(fileId: string) {
    if (!confirm(t("media.bulk.deleteConfirm", { count: 1 }))) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setOpenMenuId(null);
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
      setDeleteErrors((prev) => ({ ...prev, [fileId]: t("media.error.deleteFailed") }));
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  async function handleRenameFile(fileId: string, currentFilename: string) {
    const newName = prompt(t("media.rename.prompt"), currentFilename)?.trim();
    if (!newName) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setOpenMenuId(null);
    setRenamingIds((prev) => new Set(prev).add(fileId));
    setRenameErrors((prev) => ({ ...prev, [fileId]: "" }));

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
      setRenameErrors((prev) => ({ ...prev, [fileId]: t("media.error.renameFailed") }));
    } finally {
      setRenamingIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

  async function handleGenerateThumbnail(fileId: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setOpenMenuId(null);
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

    setOpenMenuId(null);
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
      // change on regenerate, and this page's load effect dedupes by id
      // (loadedThumbIdsRef) so it won't refetch on its own — pull a fresh
      // presigned URL + blob directly so the card shows the new image.
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

  // The lightbox must always show the full-resolution original — never the
  // small generated thumbnail a card may be using for `thumbnailUrls[f.id]`.
  // For images this means a distinct fetch via /api/download/[id], done on
  // demand only when the lightbox is actually opened (not eagerly for every
  // card, which would defeat the point of switching cards to thumbnails).
  // Video/PDF have no "original that's also an image" to show in an <img>
  // lightbox, so they keep showing their already-loaded thumbnail, same as
  // before this feature.
  async function openLightbox(f: MediaFile) {
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

  async function handleAssignToCollection(fileId: string, collectionId: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setOpenMenuId(null);
    setAssigningIds((prev) => new Set(prev).add(fileId));
    setAssignErrors((prev) => ({ ...prev, [fileId]: "" }));

    try {
      const res = await fetch(`/api/resources/${fileId}/collections`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ collectionId }),
      });
      if (!res.ok) throw new Error(`${res.status}`);

      // Refetch rather than patch local state — the tree picker doesn't keep
      // a full id→name map (it only knows names for nodes it has actually
      // fetched), so this is the one reliable way to get the new collection's
      // name onto the card; it also naturally drops the file from an
      // "Unassigned only" filtered view exactly like every other mutation here.
      await fetchMedia();
    } catch {
      setAssignErrors((prev) => ({ ...prev, [fileId]: t("media.error.assignFailed") }));
    } finally {
      setAssigningIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  }

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

  async function handleBulkAddToCollection(collectionId: string) {
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    const ids = Array.from(selectedIds);
    setBulkStatus("adding");
    setBulkSummary(null);
    setBulkProgress({ current: 0, total: ids.length });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i++) {
      try {
        const res = await fetch(`/api/resources/${ids[i]}/collections`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ collectionId }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        succeeded++;
      } catch {
        failed++;
      }
      setBulkProgress({ current: i + 1, total: ids.length });
    }

    setBulkStatus("idle");
    setBulkProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkSummary(
      t("media.bulk.addedClause", { count: succeeded }) +
        (failed > 0 ? t("common.listSeparator") + t("media.upload.failedClause", { count: failed }) : "")
    );
    await fetchMedia();
  }

  async function handleBulkDownload() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setBulkStatus("zipping");
    setBulkProgress({ current: 0, total: ids.length });
    setBulkSummary(null);

    const zip = new JSZip();
    const usedNames = new Map<string, number>();
    let skipped = 0;

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

      setBulkProgress({ current: i + 1, total: ids.length });
    }

    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const objectUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = "media-selection.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);

    setBulkStatus("idle");
    setBulkProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkSummary(
      t("media.bulk.downloadedClause", { count: ids.length - skipped }) +
        (skipped > 0 ? t("common.listSeparator") + t("media.upload.failedClause", { count: skipped }) : "")
    );
    await fetchMedia();
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(t("media.bulk.deleteConfirm", { count: ids.length }))) return;

    const token = localStorage.getItem("token");
    if (!token) { router.replace("/"); return; }

    setBulkStatus("deleting");
    setBulkSummary(null);
    setBulkProgress({ current: 0, total: ids.length });

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
      }
      setBulkProgress({ current: i + 1, total: ids.length });
    }

    setBulkStatus("idle");
    setBulkProgress(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkSummary(
      t("media.bulk.deletedClause", { count: succeeded }) +
        (failed > 0 ? t("common.listSeparator") + t("media.upload.failedClause", { count: failed }) : "")
    );
    await fetchMedia();
  }

  if (!authorized) return null;

  if (notAdmin) {
    return (
      <div className="min-h-screen bg-content-base flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-semibold text-ink">{t("common.notAuthorized")}</p>
          <Link href="/home" className="mt-3 inline-block text-sm text-brand hover:underline">
            {t("common.backToHome")}
          </Link>
        </div>
      </div>
    );
  }

  const showStatusStrip =
    uploadStatus !== "idle" || importStatus === "importing" || !!importError;

  const topBarActions = (
    <>
      {/* Search */}
      <div className="relative w-56 lg:w-64">
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
          value={qInput}
          onChange={(e) => { setQInput(e.target.value); setPage(1); }}
          placeholder={t("media.search.placeholder")}
          className="dam-glass h-10 w-full rounded-[10px] pl-9 pr-8 text-[14px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15"
        />
        {qInput && (
          <button
            onClick={() => { setQInput(""); setPage(1); }}
            aria-label={t("media.search.clear")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 cursor-pointer text-slate hover:text-ink"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        )}
      </div>

      <ViewToggle value={view} onChange={handleViewChange} />

      {/* Target collection for Upload/Import URL — required for a tenant
          admin (Stage 102): an Unassigned resource is outside every
          tenant's reach, so both actions below stay disabled until one is
          picked. Not rendered for a super admin — their Upload/Import
          controls are unchanged, still optional. No allowNone: the point is
          to force a real pick, not offer an "All collections"/none option. */}
      {!isSuperAdmin && (
        <div className="min-w-[200px]">
          <CollectionTreePicker
            value={uploadTargetCollectionId}
            onChange={setUploadTargetCollectionId}
            placeholder={t("media.upload.targetPlaceholder")}
          />
        </div>
      )}

      {/* Import from URL — creates Unassigned files for a super admin only;
          a tenant admin must have uploadTargetCollectionId set (button
          disabled otherwise, see below) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setImportPopoverOpen((v) => !v)}
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
                disabled={
                  importStatus === "importing" ||
                  !importUrl.trim() ||
                  (!isSuperAdmin && !uploadTargetCollectionId)
                }
                className="cursor-pointer whitespace-nowrap rounded-[8px] bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
              >
                {importStatus === "importing" ? t("media.import.submitting") : t("media.import.submit")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Upload — hidden file input, opened by the button; same onChange/upload pipeline */}
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
        disabled={uploadStatus === "uploading" || (!isSuperAdmin && !uploadTargetCollectionId)}
        title={
          !isSuperAdmin && !uploadTargetCollectionId
            ? t("media.upload.chooseCollectionFirst")
            : undefined
        }
        className="h-10 cursor-pointer whitespace-nowrap rounded-[10px] bg-brand px-4 text-[14px] font-semibold text-white shadow-[0_6px_16px_var(--shadow-color-brand)] transition-colors hover:bg-brand-hover disabled:opacity-50"
      >
        {uploadStatus === "uploading"
          ? t("media.upload.uploadingShort", { current: uploadProgress?.current ?? "…", total: uploadProgress?.total ?? "…" })
          : selectedFiles.length > 0
          ? t("media.upload.button", { count: selectedFiles.length })
          : t("media.upload.buttonIdle")}
      </button>
    </>
  );

  const detailsFile = files.find((f) => f.id === detailsResourceId) ?? null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <AppShell active="media" title={t("media.pageTitle")} actions={topBarActions}>
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

      {/* Transparent backdrop — closes any open kebab menu / import popover on outside click.
          (The collection tree picker manages its own backdrop/close via its own portal.) */}
      {(openMenuId !== null || importPopoverOpen) && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => { setOpenMenuId(null); setImportPopoverOpen(false); }}
        />
      )}

      {/* Upload progress / summary + import error — small frosted strip below the top bar */}
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

      {/* Filter toolbar — lighter frosted glass than the top bar */}
      <div className="dam-glass-light mb-6 flex flex-wrap items-center gap-3 rounded-[12px] px-4 py-3">
        {/* Collection — expand/collapse tree, lazy-loaded per level */}
        <div className="min-w-[220px]">
          <CollectionTreePicker
            value={collectionFilter || null}
            onChange={(id) => handleCollectionFilterChange(id ?? "")}
            allowNone
            rootLabel={t("media.filters.allCollections")}
          />
        </div>

        {/* Type */}
        <Select
          ariaLabel={t("media.filters.typeAriaLabel")}
          value={typeFilter}
          onChange={(v) => { setTypeFilter(v); setPage(1); }}
          options={[
            { value: "", label: t("media.filters.allTypes") },
            { value: "image", label: t("media.filters.images") },
            { value: "video", label: t("media.filters.videos") },
            { value: "audio", label: t("media.filters.audio") },
            { value: "other", label: t("media.filters.other") },
          ]}
          className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
        />

        {/* Sort */}
        <Select
          ariaLabel={t("media.filters.sortAriaLabel")}
          value={sortFilter}
          onChange={handleSortChange}
          options={[
            { value: "newest", label: t("media.filters.sortNewest") },
            { value: "oldest", label: t("media.filters.sortOldest") },
            { value: "largest", label: t("media.filters.sortLargest") },
            { value: "smallest", label: t("media.filters.sortSmallest") },
            { value: "name_asc", label: t("media.filters.sortNameAsc") },
            { value: "name_desc", label: t("media.filters.sortNameDesc") },
          ]}
          className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-white/80 dark:bg-card px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
        />

        {/* Unassigned checkbox — super-admin only. An unassigned resource is
            in no collection at all, so it can never be in any tenant's
            reachable scope; for a tenant admin this filter would always
            return zero results, so it's hidden entirely rather than left as
            a control that silently does nothing. Also mutually exclusive
            with a collection filter for a super admin: a file can't be both
            in a collection and unassigned, so this is disabled (rather than
            left enabled to silently return zero rows) whenever a collection
            is selected. */}
        {isSuperAdmin && (
          <label
            className={`flex select-none items-center gap-2 text-sm text-ink ${
              collectionFilter ? "cursor-not-allowed opacity-50" : "cursor-pointer"
            }`}
            title={collectionFilter ? t("media.filters.unassignedDisabledHint") : undefined}
          >
            <input
              type="checkbox"
              checked={unassignedOnly}
              disabled={!!collectionFilter}
              onChange={(e) => { setUnassignedOnly(e.target.checked); setPage(1); }}
              className="h-4 w-4 rounded border-line accent-brand disabled:cursor-not-allowed"
            />
            {t("media.filters.unassignedOnly")}
          </label>
        )}

        <div className="ml-auto flex items-center gap-3">
          {!loading && !fetchError && (
            <p className="text-sm text-slate">
              {t("media.fileCount", { count: total })}
            </p>
          )}
          {!selectMode && files.length > 0 && (
            <button
              onClick={() => {
                setSelectMode(true);
                setBulkSummary(null);
                setOpenMenuId(null);
              }}
              className="cursor-pointer rounded-[8px] border border-line bg-white/80 dark:bg-white/10 px-3 py-1.5 text-sm text-ink hover:bg-card"
            >
              {t("media.select.enter")}
            </button>
          )}
        </div>
      </div>

      {/* Bulk selection bar — visible in select mode */}
      {selectMode && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[12px] border border-selected-ring bg-surface-tint/75 px-4 py-3 backdrop-blur-md">
          <span className="text-sm font-medium text-brand">
            {t("media.select.count", { count: selectedIds.size })}
          </span>
          <button
            onClick={toggleSelectAll}
            disabled={bulkStatus !== "idle" || files.length === 0}
            className="cursor-pointer text-sm font-medium text-brand underline hover:text-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {selectedIds.size === files.length && files.length > 0 ? t("media.select.deselectAll") : t("media.select.selectAllPage")}
          </button>
          {bulkStatus === "adding" && bulkProgress && (
            <span className="text-sm text-brand">
              {t("media.select.adding", { current: bulkProgress.current, total: bulkProgress.total })}
            </span>
          )}
          {bulkStatus === "deleting" && bulkProgress && (
            <span className="text-sm text-brand">
              {t("media.select.deleting", { current: bulkProgress.current, total: bulkProgress.total })}
            </span>
          )}
          {bulkStatus === "zipping" && bulkProgress && (
            <span className="text-sm text-brand">
              {t("media.select.zipping", { current: bulkProgress.current, total: bulkProgress.total })}
            </span>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Add to collection — commits immediately per pick, no persisted selection */}
            <CollectionTreePicker
              value={null}
              onChange={(id) => id && handleBulkAddToCollection(id)}
              commitOnSelect
              placeholder={t("media.select.addToCollection")}
              disabled={selectedIds.size === 0 || bulkStatus !== "idle"}
              className="cursor-pointer rounded-[8px] border border-line bg-white/90 dark:bg-white/10 px-3 py-1.5 text-sm text-ink hover:bg-card disabled:cursor-not-allowed disabled:opacity-50"
            />

            <button
              onClick={handleBulkDownload}
              disabled={selectedIds.size === 0 || bulkStatus !== "idle"}
              className="cursor-pointer rounded-[8px] bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {bulkStatus === "zipping" ? t("media.select.preparingDownload") : t("common.download")}
            </button>

            <button
              onClick={handleBulkDelete}
              disabled={selectedIds.size === 0 || bulkStatus !== "idle"}
              className="cursor-pointer rounded-[8px] bg-red-600 dark:bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 dark:hover:bg-red-500 disabled:opacity-50"
            >
              {bulkStatus === "deleting" ? t("common.deleting") : t("common.deletePermanently")}
            </button>

            <button
              onClick={() => {
                setSelectMode(false);
                setSelectedIds(new Set());
                setBulkStatus("idle");
                setBulkProgress(null);
              }}
              disabled={bulkStatus !== "idle"}
              className="cursor-pointer rounded-[8px] border border-line bg-white/90 dark:bg-white/10 px-3 py-1.5 text-sm text-ink hover:bg-card disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Summary shown after a bulk action completes */}
      {bulkSummary && !selectMode && (
        <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">{bulkSummary}</p>
      )}

      {/* Loading / error / empty states */}
      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {fetchError && <p className="text-sm text-red-600 dark:text-red-400">{fetchError}</p>}
      {!loading && !fetchError && files.length === 0 && (
        <p className="text-sm text-slate">{t("media.states.empty")}</p>
      )}

      {/* File grid */}
      {!fetchError && files.length > 0 && view === "grid" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {files.map((f) => {
            const isUnassigned = f.collections.length === 0;
            const thumb = thumbnailUrls[f.id];

            return (
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
                {/* Thumbnail / type label */}
                <div
                  className={`relative aspect-[4/3] w-full overflow-hidden ${
                    f.mime_type === "application/pdf" && thumb ? "bg-white" : "bg-surface-tint"
                  }`}
                >
                  {thumb ? (
                    <>
                      <img
                        src={thumb}
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

                {/* Kebab (three-dot) menu — admin-only; hidden in select mode */}
                {!selectMode && (
                <div className="absolute right-2 top-2 z-20">
                  <button
                    onClick={() => setOpenMenuId(openMenuId === f.id ? null : f.id)}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/70 text-ink shadow backdrop-blur-sm hover:bg-white/90 dark:bg-black/40 dark:hover:bg-black/60"
                    aria-label={t("media.kebab.fileActions")}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <circle cx="10" cy="4" r="1.5" />
                      <circle cx="10" cy="10" r="1.5" />
                      <circle cx="10" cy="16" r="1.5" />
                    </svg>
                  </button>
                  {openMenuId === f.id && (
                    <div className="absolute right-0 top-8 z-30 w-48 rounded-[10px] border border-line bg-card py-1 shadow-lg">
                      <button
                        onClick={() => handleRenameFile(f.id, f.original_filename)}
                        disabled={renamingIds.has(f.id)}
                        className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                      >
                        {renamingIds.has(f.id) ? t("common.renaming") : t("common.rename")}
                      </button>
                      <button
                        onClick={() => { setOpenMenuId(null); router.push(`/resources/${f.id}/metadata`); }}
                        className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                      >
                        {t("common.editMetadata")}
                      </button>
                      {supportsGeneratedThumbnail(f.mime_type) && (
                        <button
                          onClick={() => f.thumbnail_storage_key ? handleRegenerateThumbnail(f.id) : handleGenerateThumbnail(f.id)}
                          disabled={generatingThumbIds.has(f.id)}
                          className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                        >
                          {generatingThumbIds.has(f.id)
                            ? (f.thumbnail_storage_key ? t("media.kebab.regenerating") : t("media.kebab.generating"))
                            : (f.thumbnail_storage_key ? t("media.kebab.regenerateThumbnail") : t("media.kebab.generateThumbnail"))}
                        </button>
                      )}
                      <CollectionTreePicker
                        value={null}
                        onChange={(id) => id && handleAssignToCollection(f.id, id)}
                        commitOnSelect
                        placeholder={assigningIds.has(f.id) ? t("media.kebab.adding") : t("media.select.addToCollection")}
                        disabled={assigningIds.has(f.id)}
                        excludeIds={f.collections.map((c) => c.id)}
                        className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
                      />
                      <button
                        onClick={() => handlePermanentDelete(f.id)}
                        disabled={deletingIds.has(f.id)}
                        className="w-full cursor-pointer px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                      >
                        {deletingIds.has(f.id) ? t("common.deleting") : t("common.deletePermanently")}
                      </button>
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

                  {/* Description */}
                  {f.description && (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate">
                      {f.description}
                    </p>
                  )}

                  {/* Details — opens the metadata drawer (whole page is admin-gated) */}
                  <button
                    onClick={() => setDetailsResourceId(f.id)}
                    className="mt-2 flex w-fit cursor-pointer items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
                  >
                    <InfoIcon />
                    {t("common.details")}
                  </button>

                  {/* Inline errors */}
                  {deleteErrors[f.id] && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{deleteErrors[f.id]}</p>
                  )}
                  {renameErrors[f.id] && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{renameErrors[f.id]}</p>
                  )}
                  {thumbnailErrors[f.id] && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{thumbnailErrors[f.id]}</p>
                  )}
                  {assignErrors[f.id] && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{assignErrors[f.id]}</p>
                  )}

                  {/* Collections or unassigned badge */}
                  <div className="mt-2">
                    {isUnassigned ? (
                      <span className="inline-flex items-center rounded-full border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                        {t("media.card.unassignedBadge")}
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {f.collections.map((c) => (
                          <Link
                            key={c.id}
                            href={`/collections/${c.id}`}
                            className="inline-block rounded-full bg-surface-tint px-2.5 py-0.5 text-xs font-medium text-brand hover:bg-selected-tint"
                          >
                            {c.name}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* File list */}
      {!fetchError && files.length > 0 && view === "list" && (
        /* No overflow-hidden — a clipped panel would cut off a row's kebab dropdown
           near the bottom edge. dam-glass's backdrop-filter still makes this wrapper a
           stacking context, so it (not individual rows) is what needs raising above the
           page-level z-10 outside-click backdrop while any row's menu is open. */
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
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate">
                  {t("media.list.headerCollections")}
                </th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const isUnassigned = f.collections.length === 0;
                const thumb = thumbnailUrls[f.id];
                const rowError =
                  deleteErrors[f.id] || renameErrors[f.id] || thumbnailErrors[f.id] || assignErrors[f.id];

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
                          f.mime_type === "application/pdf" && thumb ? "bg-white" : "bg-surface-tint"
                        }`}
                      >
                        {thumb ? (
                          <>
                            <img
                              src={thumb}
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
                      {rowError && <p className="text-xs text-red-600 dark:text-red-400">{rowError}</p>}
                    </td>
                    <td className="px-5 py-2.5 text-sm text-slate">{shortTypeLabel(f.mime_type, f.original_filename)}</td>
                    <td className="px-5 py-2.5 text-sm text-slate">{formatBytes(f.size_bytes)}</td>
                    <td className="px-5 py-2.5">
                      {isUnassigned ? (
                        <span className="inline-flex items-center rounded-full border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                          {t("media.card.unassignedBadgeShort")}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {f.collections.map((c) => (
                            <Link
                              key={c.id}
                              href={`/collections/${c.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-block rounded-full bg-surface-tint px-2.5 py-0.5 text-xs font-medium text-brand hover:bg-selected-tint"
                            >
                              {c.name}
                            </Link>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setDetailsResourceId(f.id)}
                          className="flex cursor-pointer items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
                        >
                          <InfoIcon />
                          {t("common.details")}
                        </button>
                        {!selectMode && (
                          <div className="relative inline-block">
                            <button
                              onClick={() => {
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
                                <button
                                  onClick={() => handleRenameFile(f.id, f.original_filename)}
                                  disabled={renamingIds.has(f.id)}
                                  className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                                >
                                  {renamingIds.has(f.id) ? t("common.renaming") : t("common.rename")}
                                </button>
                                <button
                                  onClick={() => { setOpenMenuId(null); router.push(`/resources/${f.id}/metadata`); }}
                                  className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist"
                                >
                                  {t("common.editMetadata")}
                                </button>
                                {supportsGeneratedThumbnail(f.mime_type) && (
                                  <button
                                    onClick={() => f.thumbnail_storage_key ? handleRegenerateThumbnail(f.id) : handleGenerateThumbnail(f.id)}
                                    disabled={generatingThumbIds.has(f.id)}
                                    className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:opacity-50"
                                  >
                                    {generatingThumbIds.has(f.id)
                                      ? (f.thumbnail_storage_key ? t("media.kebab.regenerating") : t("media.kebab.generating"))
                                      : (f.thumbnail_storage_key ? t("media.kebab.regenerateThumbnail") : t("media.kebab.generateThumbnail"))}
                                  </button>
                                )}
                                <CollectionTreePicker
                                  value={null}
                                  onChange={(id) => id && handleAssignToCollection(f.id, id)}
                                  commitOnSelect
                                  placeholder={assigningIds.has(f.id) ? t("media.kebab.adding") : t("media.select.addToCollection")}
                                  disabled={assigningIds.has(f.id)}
                                  excludeIds={f.collections.map((c) => c.id)}
                                  className="w-full cursor-pointer px-4 py-2 text-left text-sm text-ink hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
                                />
                                <button
                                  onClick={() => handlePermanentDelete(f.id)}
                                  disabled={deletingIds.has(f.id)}
                                  className="w-full cursor-pointer px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                                >
                                  {deletingIds.has(f.id) ? t("common.deleting") : t("common.deletePermanently")}
                                </button>
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
      {!fetchError && total > 0 && (
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

      <MetadataDrawer
        resourceId={detailsResourceId}
        filename={detailsFile?.original_filename ?? ""}
        meta={detailsFile ? `${shortTypeLabel(detailsFile.mime_type, detailsFile.original_filename)} · ${formatBytes(detailsFile.size_bytes)}` : ""}
        canEdit={true}
        onClose={() => setDetailsResourceId(null)}
      />
    </AppShell>
  );
}
