"use client";

import { useEffect, useRef } from "react";
import ResourceMetadata from "@/components/ResourceMetadata";
import { useTranslation } from "@/lib/i18n";

interface MetadataDrawerProps {
  resourceId: string | null;
  filename: string;
  meta: string;
  canEdit: boolean;
  onClose: () => void;
}

function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  );
}

// Right-side slide-in panel showing a single asset's custom metadata.
// ResourceMetadata itself is unmodified — this just gives it a place to mount
// one asset at a time instead of inline on every file card. The `key` prop on
// ResourceMetadata (set by the caller) forces a fresh mount/fetch whenever the
// open resource changes.
export default function MetadataDrawer({
  resourceId,
  filename,
  meta,
  canEdit,
  onClose,
}: MetadataDrawerProps) {
  const { t } = useTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!resourceId) return;
    closeButtonRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId]);

  if (!resourceId) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-ink/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("resourceMetadata.drawer.ariaLabel", { filename })}
        className="dam-glass motion-safe:animate-[dam-drawer-slide-in_220ms_ease-out] fixed right-0 top-0 z-50 flex h-full w-[340px] flex-col shadow-[-8px_0_32px_rgba(0,46,92,0.18)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line/70 px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink" title={filename}>
              {filename}
            </p>
            <p className="mt-0.5 text-xs text-slate">{meta}</p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label={t("resourceMetadata.drawer.closeDetails")}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-slate hover:bg-mist hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate">
            {t("resourceMetadata.heading")}
          </p>
          <ResourceMetadata resourceId={resourceId} canEdit={canEdit} key={resourceId} />
        </div>
      </div>
    </>
  );
}
