interface FileTypeIconProps {
  mimeType: string;
  className?: string;
}

type IconRenderer = (className: string) => React.ReactNode;

// Page-with-folded-corner base used by every document-family icon (text, Word,
// PDF, generic) — mirrors the fold shape already used elsewhere in the app
// (e.g. the share page's placeholder icon), varied only by an inner glyph.
function DocumentBase({ className, children }: { className: string; children?: React.ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path d="M5 2.5h6.5l3.5 3.5v11.5H5z" strokeLinejoin="round" />
      <path d="M11.5 2.5v3.5H15" strokeLinejoin="round" />
      {children}
    </svg>
  );
}

function ImageIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" strokeLinejoin="round" />
      <circle cx="7" cy="8" r="1.4" />
      <path d="M3 14.5l4-4 3 3 3.5-3.5L17 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function VideoIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <rect x="2.5" y="4.5" width="11" height="11" rx="1.5" strokeLinejoin="round" />
      <path d="M13.5 8.3l4-2.2v7.8l-4-2.2" strokeLinejoin="round" />
      <path d="M7 7.8l3.2 2-3.2 2v-4z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AudioIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <circle cx="6" cy="14.5" r="2" />
      <circle cx="14" cy="12.5" r="2" />
      <path d="M8 14.5V5l8-1.6v8.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PdfIcon({ className }: { className: string }) {
  return (
    <DocumentBase className={className}>
      <rect x="4" y="12.5" width="9" height="4" rx="0.8" fill="currentColor" stroke="none" />
    </DocumentBase>
  );
}

function TextIcon({ className }: { className: string }) {
  return (
    <DocumentBase className={className}>
      <path d="M7 11h6M7 13.5h6M7 16h4" strokeLinecap="round" />
    </DocumentBase>
  );
}

function WordIcon({ className }: { className: string }) {
  return (
    <DocumentBase className={className}>
      <path d="M7 11h6M7 13.5h6M7 16h6" strokeLinecap="round" />
    </DocumentBase>
  );
}

function ExcelIcon({ className }: { className: string }) {
  return (
    <DocumentBase className={className}>
      <path d="M6.5 10.5h7v6h-7z" strokeLinejoin="round" />
      <path d="M6.5 13.5h7M10 10.5v6" />
    </DocumentBase>
  );
}

function PresentationIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <rect x="2.5" y="4" width="15" height="9.5" rx="1.5" strokeLinejoin="round" />
      <path d="M8 9l3.5 2.2L8 13.4V9z" fill="currentColor" stroke="none" />
      <path d="M8 17h4" strokeLinecap="round" />
    </svg>
  );
}

function ArchiveIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <rect x="2.5" y="5" width="15" height="12" rx="1.5" strokeLinejoin="round" />
      <path d="M2.5 5h15M9 5v2M11 8.5v1.5M9 11.5v1.5M11 14.5v1.5" strokeLinecap="round" />
    </svg>
  );
}

function GenericFileIcon({ className }: { className: string }) {
  return <DocumentBase className={className} />;
}

// MIME family → (icon renderer, accent color). Branch-selected below, never
// string-interpolated. Falls through to the generic file icon for anything
// unrecognized so an odd/unknown MIME type never crashes or renders raw text.
function resolve(mimeType: string): { render: IconRenderer; color: string } {
  if (mimeType.startsWith("image/")) return { render: (c) => <ImageIcon className={c} />, color: "text-sky-500 dark:text-sky-400" };
  if (mimeType.startsWith("video/")) return { render: (c) => <VideoIcon className={c} />, color: "text-rose-500 dark:text-rose-400" };
  if (mimeType.startsWith("audio/")) return { render: (c) => <AudioIcon className={c} />, color: "text-violet-500 dark:text-violet-400" };
  if (mimeType === "application/pdf") return { render: (c) => <PdfIcon className={c} />, color: "text-red-600 dark:text-red-400" };

  if (
    mimeType === "application/zip" ||
    mimeType === "application/x-zip-compressed" ||
    mimeType === "application/gzip" ||
    mimeType === "application/x-tar" ||
    mimeType === "application/x-7z-compressed" ||
    mimeType === "application/x-rar-compressed"
  ) {
    return { render: (c) => <ArchiveIcon className={c} />, color: "text-amber-600 dark:text-amber-400" };
  }

  if (
    mimeType === "application/msword" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return { render: (c) => <WordIcon className={c} />, color: "text-blue-600 dark:text-blue-400" };
  }

  if (
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return { render: (c) => <ExcelIcon className={c} />, color: "text-green-600 dark:text-green-400" };
  }

  if (
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return { render: (c) => <PresentationIcon className={c} />, color: "text-orange-500 dark:text-orange-400" };
  }

  if (mimeType.startsWith("text/")) return { render: (c) => <TextIcon className={c} />, color: "text-slate-600 dark:text-slate-400" };

  return { render: (c) => <GenericFileIcon className={c} />, color: "text-slate" };
}

// Google-Drive-style fallback icon shown wherever no real preview is available
// (no image blob, no generated video thumbnail). Never renders raw MIME text.
export default function FileTypeIcon({ mimeType, className = "h-8 w-8" }: FileTypeIconProps) {
  const { render, color } = resolve(mimeType);
  return <>{render(`${className} ${color}`)}</>;
}
