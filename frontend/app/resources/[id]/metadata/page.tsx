"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import ResourceMetadata, { ResourceMetadataHandle } from "@/components/ResourceMetadata";
import FileTypeIcon from "@/components/FileTypeIcon";
import { shortTypeLabel } from "@/lib/fileTypes";
import { useTranslation } from "@/lib/i18n";

interface ResourceDetail {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  thumbnail_storage_key: string | null;
}

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function BackIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12.5 4.5L6 10l6.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EditResourceMetadataPageInner() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const { t } = useTranslation();

  // Optional queue-workflow mode, driven entirely by query params so the
  // position survives a refresh: `batch` is an ordered, comma-separated list
  // of resource ids; `i` is the 0-based index of the current asset within it;
  // `return` is where to land after the last item (or "Finish later"). Only
  // treated as workflow mode when the batch/index are well-formed AND
  // batch[i] actually matches this page's own [id] — otherwise this behaves
  // exactly like the standalone editor (no batch param at all).
  const batchParam = searchParams.get("batch");
  const iParam = searchParams.get("i");
  const returnParam = searchParams.get("return");

  const batchIds = batchParam
    ? batchParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const index = iParam !== null && iParam !== "" ? Number(iParam) : null;
  const isWorkflow =
    batchIds !== null &&
    batchIds.length > 0 &&
    index !== null &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < batchIds.length &&
    batchIds[index] === id;
  // Only ever used to build our own same-origin navigations, but still
  // restricted to a relative path — never trust a query param as a redirect target.
  const returnPath = returnParam && returnParam.startsWith("/") ? returnParam : "/admin/media";
  const isLast = isWorkflow && index === batchIds!.length - 1;
  const nextId = isWorkflow && !isLast ? batchIds![index! + 1] : null;

  const [authorized, setAuthorized] = useState(false);
  const [notAuthorized, setNotAuthorized] = useState(false);

  const [resource, setResource] = useState<ResourceDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const metadataRef = useRef<ResourceMetadataHandle>(null);
  const [advancing, setAdvancing] = useState(false);

  function goTo(path: string) {
    router.push(path);
  }

  function advanceQueue() {
    if (isLast || nextId === null) {
      goTo(returnPath);
      return;
    }
    goTo(
      `/resources/${nextId}/metadata?batch=${encodeURIComponent(batchParam!)}&i=${index! + 1}&return=${encodeURIComponent(returnPath)}`
    );
  }

  async function handleSaveAndNext() {
    if (advancing) return;
    setAdvancing(true);
    try {
      const ok = await metadataRef.current?.save();
      if (!ok) return;
      advanceQueue();
    } finally {
      setAdvancing(false);
    }
  }

  function handleSkip() {
    if (advancing) return;
    advanceQueue();
  }

  function handleFinishLater() {
    goTo(returnPath);
  }

  // Page-level gate — no token → redirect to login; valid token but neither
  // admin nor upload-permitted (a Viewer) → "Not authorized". This only
  // confirms the user is the right *kind* of account for this page; whether
  // they can edit *this specific* resource is a per-asset check the resource
  // fetch below enforces server-side (an editor whose group can't reach this
  // asset still gets the same "Not authorized" state via the 403 branch).
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    const payload = parseToken(token);
    if (!(payload?.canAdmin || payload?.canUpload)) {
      setNotAuthorized(true);
      setAuthorized(true);
      return;
    }
    setAuthorized(true);
  }, [router]);

  useEffect(() => {
    if (!authorized || notAuthorized) return;
    fetch(`/api/resources/${id}`, { headers: authHeaders() })
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        if (r.status === 403) {
          setNotAuthorized(true);
          return null;
        }
        if (!r.ok) throw new Error(`Failed to load asset (${r.status})`);
        return r.json() as Promise<ResourceDetail>;
      })
      .then((data) => {
        if (data) setResource(data);
      })
      .catch(() => setLoadError(t("resourceMetadata.error.loadFailed")));
  }, [authorized, notAuthorized, id]);

  // Revoke the preview blob URL when it changes or on unmount.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!resource) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    (async () => {
      try {
        // Any file with a generated thumbnail (video, PDF, or now image)
        // previews that small derivative via /api/cover?key= — never the
        // full original. An image with no thumbnail yet falls back to the
        // full original via /api/download/[id] so the preview isn't blank
        // while generation is in flight.
        if (resource.thumbnail_storage_key) {
          const res = await fetch(
            `/api/cover?key=${encodeURIComponent(resource.thumbnail_storage_key)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!res.ok) return;
          const { url } = await res.json();
          const imgRes = await fetch(url);
          if (!imgRes.ok) return;
          const blob = await imgRes.blob();
          const objectUrl = URL.createObjectURL(blob);
          objectUrlRef.current = objectUrl;
          setPreviewUrl(objectUrl);
        } else if (resource.mime_type.startsWith("image/")) {
          const res = await fetch(`/api/download/${resource.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return;
          const { downloadUrl } = await res.json();
          const imgRes = await fetch(downloadUrl);
          if (!imgRes.ok) return;
          const blob = await imgRes.blob();
          const objectUrl = URL.createObjectURL(blob);
          objectUrlRef.current = objectUrl;
          setPreviewUrl(objectUrl);
        }
      } catch {
        // leave absent → type-label fallback shown instead
      }
    })();
  }, [resource]);

  if (!authorized) return null;

  if (notAuthorized) {
    return (
      <AppShell active="media" title={t("common.editMetadata")}>
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

  const backButton = (
    <button
      onClick={() => router.back()}
      className="flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-line bg-white/70 dark:bg-white/10 px-3 py-1.5 text-sm font-medium text-ink hover:bg-card"
    >
      <BackIcon />
      {t("common.cancel")}
    </button>
  );

  const finishLaterButton = (
    <button
      onClick={handleFinishLater}
      className="flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-line bg-white/70 dark:bg-white/10 px-3 py-1.5 text-sm font-medium text-ink hover:bg-card"
    >
      {t("resourceMetadata.finishLater")}
    </button>
  );

  const title = (
    <div className="flex flex-col leading-tight">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate">
        {isWorkflow ? t("resourceMetadata.workflow.stepOf", { current: index! + 1, total: batchIds!.length }) : t("common.editMetadata")}
      </span>
      <span className="block max-w-[420px] truncate" title={resource?.original_filename ?? ""}>
        {resource?.original_filename ?? "…"}
      </span>
    </div>
  );

  return (
    <AppShell active="media" title={title} actions={isWorkflow ? finishLaterButton : backButton}>
      {notFound ? (
        <div className="flex items-center justify-center py-24">
          <div className="text-center">
            <p className="text-lg font-semibold text-ink">{t("resourceMetadata.notFound.title")}</p>
            <Link href="/admin/media" className="mt-3 inline-block text-sm text-brand hover:underline">
              {t("resourceMetadata.notFound.backToMedia")}
            </Link>
          </div>
        </div>
      ) : loadError ? (
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
      ) : !resource ? (
        <p className="text-sm text-slate">{t("common.loading")}</p>
      ) : (
        <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          {/* Left — full metadata form, scrollable */}
          <div className="min-w-0 flex-1">
            <div className="dam-glass rounded-[14px] p-6 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
              <h2 className="mb-4 text-base font-semibold text-ink">{t("resourceMetadata.heading")}</h2>
              {isWorkflow ? (
                <ResourceMetadata
                  resourceId={resource.id}
                  canEdit={true}
                  autoEdit
                  hideActions
                  enforceRequired
                  ref={metadataRef}
                />
              ) : (
                <ResourceMetadata resourceId={resource.id} canEdit={true} autoEdit />
              )}
            </div>
          </div>

          {/* Right — asset preview, sticky */}
          <div className="w-full shrink-0 lg:sticky lg:top-8 lg:w-[300px]">
            <div className="dam-glass overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
              <div
                className={`relative flex h-56 items-center justify-center overflow-hidden ${
                  resource.mime_type === "application/pdf" && previewUrl ? "bg-white" : "bg-surface-tint"
                }`}
              >
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={resource.original_filename}
                    className={
                      resource.mime_type === "application/pdf"
                        ? "h-full w-full object-cover object-top"
                        : "h-full w-full object-contain"
                    }
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center gap-1.5">
                    <FileTypeIcon mimeType={resource.mime_type} className="h-10 w-10" />
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate">
                      {shortTypeLabel(resource.mime_type, resource.original_filename)}
                    </span>
                  </div>
                )}
              </div>
              <div className="border-t border-line/70 p-4">
                <p className="truncate text-sm font-medium text-ink" title={resource.original_filename}>
                  {resource.original_filename}
                </p>
                <p className="mt-0.5 text-xs text-slate">
                  {shortTypeLabel(resource.mime_type, resource.original_filename)} · {formatBytes(resource.size_bytes)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {isWorkflow && (
          <div className="flex items-center justify-between gap-3 dam-glass rounded-[14px] p-4 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
            <p className="text-xs text-slate">
              {t("resourceMetadata.workflow.stepOf", { current: index! + 1, total: batchIds!.length })}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSkip}
                disabled={advancing}
                className="cursor-pointer rounded-[8px] border border-line bg-white/70 dark:bg-white/10 px-4 py-2 text-sm font-medium text-ink hover:bg-card disabled:opacity-50"
              >
                {t("resourceMetadata.workflow.skip")}
              </button>
              <button
                onClick={handleSaveAndNext}
                disabled={advancing}
                className="cursor-pointer rounded-[8px] bg-brand px-4 py-2 text-sm font-medium text-white shadow-[0_4px_14px_var(--shadow-color-brand)] hover:bg-brand-hover disabled:opacity-50"
              >
                {advancing ? t("common.saving") : isLast ? t("resourceMetadata.workflow.saveFinish") : t("resourceMetadata.workflow.saveNext")}
              </button>
            </div>
          </div>
        )}
        </div>
      )}
    </AppShell>
  );
}

export default function EditResourceMetadataPage() {
  return (
    <Suspense fallback={null}>
      <EditResourceMetadataPageInner />
    </Suspense>
  );
}
