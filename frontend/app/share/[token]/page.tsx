"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Inter, Manrope } from "next/font/google";
import FileTypeIcon from "@/components/FileTypeIcon";
import { shortTypeLabel } from "@/lib/fileTypes";
import { useTranslation, LOCALE_KEY } from "@/lib/i18n";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"] });
const manrope = Manrope({ subsets: ["latin"], weight: ["600", "700"] });

type ShareStatus = "loading" | "valid" | "expired" | "revoked" | "invalid";
type AccessLevel = "view" | "download";

interface ShareFile {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  hasThumbnail: boolean;
}

interface ShareData {
  accessLevel: AccessLevel;
  expiresAt: string | null;
  target: { type: "collection" | "resource"; name: string };
  files: ShareFile[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DownloadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3v9m0 0l-3.5-3.5M10 12l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14v2a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0016 16v-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SharePage() {
  const params = useParams();
  const token = params.token as string;
  const { t, setLocale } = useTranslation();

  const [status, setStatus] = useState<ShareStatus>("loading");
  const [data, setData] = useState<ShareData | null>(null);

  const [previews, setPreviews] = useState<Record<string, { url: string | null; mimeType: string } | undefined>>({});
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [lightboxFile, setLightboxFile] = useState<ShareFile | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  // This is the one page in the app with no logged-in account, so there's no
  // account-menu language preference and no prior "authorized" gate to hide
  // behind while the locale settles. Resolution order: an explicit
  // `dam:locale` already in this browser wins (respects a deliberate past
  // choice — e.g. the recipient also uses the app as a real user on this
  // device); otherwise fall back to the browser's own language
  // (navigator.languages/navigator.language) for a first-time visitor who's
  // never touched the app; otherwise English. Reuses the existing shared
  // `setLocale()` (same one the account-menu switcher calls) rather than a
  // bespoke local dictionary, so it also persists the detected choice to
  // `dam:locale` — a recipient who later gets invited to create an account
  // on this same browser lands in the language their browser already told
  // us, instead of a surprise reset to English. No manual language toggle is
  // added here: auto-detect alone satisfies "a recipient who's never used
  // the app shouldn't be stuck in English," and a toggle would be a second
  // control with nothing to switch away from on a page with no other chrome.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCALE_KEY);
      if (!stored) {
        const browserLang =
          (navigator.languages && navigator.languages[0]) || navigator.language || "";
        if (browserLang.toLowerCase().startsWith("it")) {
          setLocale("it");
        }
        // Anything else (including no navigator language at all) leaves the
        // provider's own default, which is already English.
      }
    } catch {
      // localStorage unavailable (e.g. private browsing) — leave the
      // English default rather than fail the page over a preference.
    }
    // Runs once on mount only — this is a one-time detection, not a
    // continuous sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (body.status === "valid") {
          setData(body as ShareData);
          setStatus("valid");
        } else {
          setStatus((body.status as ShareStatus) ?? "invalid");
        }
      })
      .catch(() => setStatus("invalid"));
  }, [token]);

  useEffect(() => {
    if (status !== "valid" || !data) return;
    let cancelled = false;
    for (const f of data.files) {
      fetch(`/api/share/${encodeURIComponent(token)}/file/${f.id}?mode=view`)
        .then((r) => (r.ok ? r.json() : { url: null, mimeType: f.mime_type }))
        .then((body) => {
          if (cancelled) return;
          setPreviews((prev) => ({ ...prev, [f.id]: { url: body.url ?? null, mimeType: body.mimeType ?? f.mime_type } }));
        })
        .catch(() => {
          if (!cancelled) setPreviews((prev) => ({ ...prev, [f.id]: { url: null, mimeType: f.mime_type } }));
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, data, token]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  // The gallery grid shows the small thumbnail (previews[f.id], mode=view),
  // but the lightbox must always show the full-resolution original — fetched
  // on demand via mode=original, which (like `view` always did for images
  // before this feature) isn't gated by accessLevel; the existing
  // save/drag/right-click deterrents below still apply for view-only shares.
  async function openLightbox(f: ShareFile) {
    setLightboxFile(f);
    setLightboxUrl(null);
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/file/${f.id}?mode=original`);
      if (!res.ok) return;
      const body = await res.json();
      if (body.url) setLightboxUrl(body.url);
    } catch {
      // leave null — lightbox simply won't render (see the render guard below)
    }
  }

  async function handleDownload(f: ShareFile) {
    setDownloadingIds((prev) => new Set(prev).add(f.id));
    setDownloadErrors((prev) => { const n = { ...prev }; delete n[f.id]; return n; });
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/file/${f.id}?mode=download`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDownloadErrors((prev) => ({ ...prev, [f.id]: body.error ?? t("common.error.generic", { status: res.status }) }));
        return;
      }
      const fileRes = await fetch(body.url);
      const blob = await fileRes.blob();
      const objectUrl = URL.createObjectURL(blob);
      objectUrlsRef.current.push(objectUrl);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = body.filename ?? f.original_filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setDownloadErrors((prev) => ({ ...prev, [f.id]: t("common.error.couldNotReachServer") }));
    } finally {
      setDownloadingIds((prev) => { const n = new Set(prev); n.delete(f.id); return n; });
    }
  }

  return (
    <div className={`${inter.className} flex min-h-screen flex-col bg-content-base`}>
      <style>{`
        /* .share-glass now lives in globals.css, aliased to .dam-glass's
           canonical definition (identical values, no longer duplicated here). */
        /* Casual-save friction for view-only shares: deters right-click-save and
           drag-to-desktop. Not real content protection — screenshots, dev tools,
           and the network tab can still get the bytes, which is expected. */
        .share-no-save {
          user-select: none;
          -webkit-user-select: none;
          -webkit-user-drag: none;
        }
      `}</style>

      <header className="flex h-[60px] w-full shrink-0 items-center justify-center bg-brand-dark">
        <img
          src="/coperon-technologies.png"
          alt="Coperon Technologies"
          className="h-auto w-[150px]"
          style={{ filter: "brightness(0) invert(1)" }}
        />
      </header>

      <main className="flex flex-1 flex-col items-center px-4 py-10">
        {status === "loading" && <p className="text-sm text-slate">{t("common.loading")}</p>}

        {status === "expired" && (
          <div className="mt-16 text-center">
            <p className={`${manrope.className} text-xl font-bold text-ink`}>{t("share.status.expiredTitle")}</p>
            <p className="mt-2 text-sm text-slate">{t("share.status.askSender")}</p>
          </div>
        )}

        {status === "revoked" && (
          <div className="mt-16 text-center">
            <p className={`${manrope.className} text-xl font-bold text-ink`}>{t("share.status.revokedTitle")}</p>
            <p className="mt-2 text-sm text-slate">{t("share.status.askSender")}</p>
          </div>
        )}

        {status === "invalid" && (
          <div className="mt-16 text-center">
            <p className={`${manrope.className} text-xl font-bold text-ink`}>{t("share.status.invalidTitle")}</p>
          </div>
        )}

        {status === "valid" && data && (
          <div className="w-full max-w-5xl">
            <div className="mb-6">
              <h1 className={`${manrope.className} text-2xl font-bold text-ink`}>{data.target.name}</h1>
              <p className="mt-1 text-sm text-slate">
                {t(data.target.type === "collection" ? "share.header.typeCollection" : "share.header.typeFile")}
                {" · "}
                {t(data.accessLevel === "download" ? "share.header.accessDownload" : "share.header.accessView")}
                {data.expiresAt &&
                  ` · ${t("share.header.expiresOn", { date: new Date(data.expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) })}`}
              </p>
            </div>

            {data.files.length === 0 ? (
              <p className="share-glass rounded-[14px] px-5 py-6 text-sm text-slate">{t("share.empty")}</p>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {data.files.map((f) => {
                  const preview = previews[f.id];
                  // Render <img> only when the preview endpoint actually returned image
                  // bytes (original image, or a video's JPEG thumbnail) — never for a
                  // download-share's original-file preview URL on a non-image type,
                  // which would otherwise render as a broken image icon.
                  const previewIsImage = Boolean(preview?.url && preview.mimeType.startsWith("image/"));
                  const downloading = downloadingIds.has(f.id);
                  const error = downloadErrors[f.id];
                  return (
                    <div key={f.id} className="share-glass flex flex-col overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
                      <button
                        type="button"
                        onClick={() => previewIsImage && openLightbox(f)}
                        className={`flex h-32 w-full items-center justify-center bg-mist text-slate ${previewIsImage ? "cursor-pointer" : "cursor-default"}`}
                      >
                        {previewIsImage ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={preview!.url!}
                            alt={f.original_filename}
                            className={`h-full w-full object-cover${data.accessLevel === "view" ? " share-no-save" : ""}`}
                            draggable={data.accessLevel === "view" ? false : undefined}
                            onContextMenu={data.accessLevel === "view" ? (e) => e.preventDefault() : undefined}
                            onDragStart={data.accessLevel === "view" ? (e) => e.preventDefault() : undefined}
                          />
                        ) : (
                          <FileTypeIcon mimeType={f.mime_type} className="h-8 w-8" />
                        )}
                      </button>
                      <div className="flex flex-1 flex-col gap-1 p-3">
                        <p className="truncate text-xs font-medium text-ink" title={f.original_filename}>
                          {f.original_filename}
                        </p>
                        <p className="text-[11px] text-slate">
                          {shortTypeLabel(f.mime_type, f.original_filename)} · {formatBytes(f.size_bytes)}
                        </p>
                        {data.accessLevel === "download" && (
                          <button
                            onClick={() => handleDownload(f)}
                            disabled={downloading}
                            className="mt-1 flex cursor-pointer items-center justify-center gap-1.5 rounded-[8px] bg-brand px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <DownloadIcon />
                            {downloading ? t("share.download.inProgress") : t("common.download")}
                          </button>
                        )}
                        {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {lightboxFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => { setLightboxFile(null); setLightboxUrl(null); }}
        >
          {lightboxUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={lightboxUrl}
              alt={lightboxFile.original_filename}
              className={`max-h-full max-w-full rounded-[8px] object-contain${data?.accessLevel === "view" ? " share-no-save" : ""}`}
              draggable={data?.accessLevel === "view" ? false : undefined}
              onContextMenu={data?.accessLevel === "view" ? (e) => e.preventDefault() : undefined}
              onDragStart={data?.accessLevel === "view" ? (e) => e.preventDefault() : undefined}
            />
          ) : (
            <p className="text-sm text-white/80">{t("common.loading")}</p>
          )}
        </div>
      )}
    </div>
  );
}
