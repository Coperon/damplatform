// Short, human-readable type labels for file cards/rows — never the raw MIME
// subtype (e.g. never "VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT").
// Branch-selected/whitelisted; anything unrecognized falls back to the
// filename's extension, then to a generic "FILE" — either way, capped at 5
// characters so it never overflows the small caption space it's shown in.

const EXACT_MIME_LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
  'image/svg+xml': 'SVG',

  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',

  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',

  'application/pdf': 'PDF',

  'application/msword': 'DOCX',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',

  'application/vnd.ms-excel': 'XLSX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',

  'application/vnd.ms-powerpoint': 'PPTX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',

  'application/zip': 'ZIP',
  'application/x-zip-compressed': 'ZIP',
  'application/gzip': 'GZ',
  'application/x-tar': 'TAR',
  'application/x-7z-compressed': '7Z',
  'application/x-rar-compressed': 'RAR',

  'text/plain': 'TXT',
  'text/csv': 'CSV',

  'application/json': 'JSON',
};

function cap5(label: string): string {
  return label.slice(0, 5);
}

/**
 * mimeType is matched against an exact whitelist first, then a small set of
 * family prefixes (video/*, audio/*, text/*). If nothing matches — an
 * unrecognized or vendor-specific MIME type — the raw subtype is never
 * printed; instead this falls back to the uploaded filename's extension
 * (when given), or "FILE" if there's no usable extension.
 */
export function shortTypeLabel(mimeType: string, filename?: string): string {
  const exact = EXACT_MIME_LABELS[mimeType];
  if (exact) return cap5(exact);

  if (mimeType.startsWith('video/')) return cap5('VIDEO');
  if (mimeType.startsWith('audio/')) return cap5('AUDIO');
  if (mimeType.startsWith('text/')) return cap5('TEXT');

  if (filename) {
    const dot = filename.lastIndexOf('.');
    if (dot > -1 && dot < filename.length - 1) {
      const ext = filename.slice(dot + 1).toUpperCase();
      if (ext) return cap5(ext);
    }
  }

  return 'FILE';
}
