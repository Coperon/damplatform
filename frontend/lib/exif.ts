import exifr from 'exifr';
import db from '@/lib/db';
import { EXIF_SOURCES, type MetadataFieldType } from '@/lib/exifSources';

export type { MetadataFieldType, ExifSourceDef } from '@/lib/exifSources';
export { EXIF_SOURCES, isValidExifSource, exifSourceAppliesTo } from '@/lib/exifSources';

// exifr, called with mergeOutput:false, groups tags under the segment they
// actually came from - not under the dot-prefix our whitelist labels use.
// IPTC lands under `iptc` with exifr's own (unhyphenated) key names; XMP
// Dublin-Core properties land under a top-level `dc` key (not `xmp`); Make/
// Model/ImageWidth/ImageHeight are baseline TIFF tags under `ifd0`, while the
// rest of the EXIF IFD (DateTimeOriginal, ISO, FNumber, etc.) is under `exif`.
// This table is the only place that mapping is encoded.
type ParsedExif = Record<string, Record<string, unknown> | undefined>;

const GETTERS: Record<string, (p: ParsedExif) => unknown> = {
  'iptc.ObjectName': (p) => p.iptc?.ObjectName,
  'iptc.Caption-Abstract': (p) => p.iptc?.Caption,
  'iptc.Keywords': (p) => p.iptc?.Keywords,
  'iptc.By-line': (p) => p.iptc?.Byline,
  'iptc.Credit': (p) => p.iptc?.Credit,
  'iptc.Copyright': (p) => p.iptc?.CopyrightNotice,
  'iptc.City': (p) => p.iptc?.City,
  'iptc.Country-PrimaryLocationName': (p) => p.iptc?.Country,
  'iptc.DateCreated': (p) => p.iptc?.DateCreated,
  'xmp.title': (p) => p.dc?.title,
  'xmp.description': (p) => p.dc?.description,
  'xmp.subject': (p) => p.dc?.subject,
  'xmp.creator': (p) => p.dc?.creator,
  'xmp.rights': (p) => p.dc?.rights,
  'exif.DateTimeOriginal': (p) => p.exif?.DateTimeOriginal,
  'exif.Make': (p) => p.ifd0?.Make,
  'exif.Model': (p) => p.ifd0?.Model,
  'exif.LensModel': (p) => p.exif?.LensModel,
  'exif.ISO': (p) => p.exif?.ISO,
  'exif.FNumber': (p) => p.exif?.FNumber,
  'exif.ExposureTime': (p) => p.exif?.ExposureTime,
  'exif.FocalLength': (p) => p.exif?.FocalLength,
  'exif.ImageWidth': (p) => p.ifd0?.ImageWidth ?? p.exif?.ExifImageWidth,
  'exif.ImageHeight': (p) => p.ifd0?.ImageHeight ?? p.exif?.ExifImageHeight,
};

/**
 * Parses embedded EXIF/IPTC/XMP out of an image buffer. Images only - callers
 * must check mimeType themselves, but this also no-ops defensively. Never
 * throws: a corrupt file or one with no embedded metadata at all (exifr
 * returns `undefined` in that case) both resolve to `{}`, since a bad EXIF
 * block must never fail an upload.
 */
export async function extractMetadata(
  buffer: Buffer,
  mimeType: string,
): Promise<Record<string, unknown>> {
  if (!mimeType.startsWith('image/')) return {};

  try {
    const parsed: ParsedExif | undefined = await exifr.parse(buffer, {
      tiff: true,
      // ifd0 can't be disabled in exifr's Options type - it's always parsed
      // alongside `tiff`, which is what actually gates it.
      exif: true,
      gps: false,
      iptc: true,
      xmp: true,
      icc: false,
      jfif: false,
      interop: false,
      mergeOutput: false,
      sanitize: true,
      reviveValues: true,
      translateKeys: true,
      translateValues: true,
    });
    if (!parsed) return {};

    const out: Record<string, unknown> = {};
    for (const source of EXIF_SOURCES) {
      const raw = GETTERS[source.value](parsed);
      if (raw !== undefined && raw !== null) out[source.value] = raw;
    }
    return out;
  } catch (err) {
    console.error('lib/exif: extraction failed, treating as no metadata:', err);
    return {};
  }
}

// XMP text properties (title/description/rights/creator) are LangAlt
// structures - exifr represents a single default-language entry as
// {lang, value} rather than a plain string.
function unwrapLangAlt(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'value' in (raw as Record<string, unknown>)) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

function toSingleString(raw: unknown): string | null {
  const v = unwrapLangAlt(raw);
  if (Array.isArray(v)) {
    const parts = v.map((item) => toSingleString(item)).filter((s): s is string => Boolean(s));
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed || null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  return null;
}

function toStringList(raw: unknown): string[] {
  const v = unwrapLangAlt(raw);
  const items = Array.isArray(v) ? v : v !== undefined && v !== null ? [v] : [];
  const out: string[] = [];
  for (const item of items) {
    const s = toSingleString(item);
    if (s) out.push(s);
  }
  return out;
}

function formatDateLocal(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The classic EXIF-date pitfall: EXIF timestamps have no timezone and exifr
// (for tags it revives, e.g. DateTimeOriginal) builds a Date from the naive
// "YYYY:MM:DD HH:MM:SS" components using *local* Date methods
// (`new Date(y, m-1, d)` + setHours/setMinutes/setSeconds) - not UTC. Reading
// it back with getUTCFullYear()/toISOString() would re-apply a timezone
// conversion on top of that and can shift the date by one day near midnight.
// This always reads such a Date with local getters to exactly undo the local
// construction. IPTC:DateCreated is a different shape again - exifr does not
// revive it, so it arrives as a raw "CCYYMMDD" digit string.
function toDateString(raw: unknown): string | null {
  if (raw instanceof Date) {
    return formatDateLocal(raw);
  }
  if (typeof raw === 'string') {
    const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/); // IPTC CCYYMMDD
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    const exifStyle = raw.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/); // unrevived "YYYY:MM:DD ..."
    if (exifStyle) return `${exifStyle[1]}-${exifStyle[2]}-${exifStyle[3]}`;
  }
  return null;
}

const MAX_TEXT_LENGTH = 2000;

/**
 * Coerces one raw extracted value into the text this field's column actually
 * stores, per field_type - or null if there's nothing usable to store (the
 * caller should then leave the field untouched). checkbox_group values are
 * filtered against the field's own options; anything not already an option
 * is dropped rather than invented.
 */
export function coerceExifValue(
  raw: unknown,
  fieldType: MetadataFieldType,
  options: string[] | null,
): string | null {
  if (raw === undefined || raw === null) return null;

  switch (fieldType) {
    case 'date':
      return toDateString(raw);

    case 'tag': {
      const list = toStringList(raw);
      if (list.length === 0) return null;
      return list.join(', ').slice(0, MAX_TEXT_LENGTH);
    }

    case 'checkbox_group': {
      if (!options || options.length === 0) return null;
      const allowed = new Set(options);
      const kept = toStringList(raw).filter((v) => allowed.has(v));
      if (kept.length === 0) return null;
      return kept.join(', ').slice(0, MAX_TEXT_LENGTH);
    }

    case 'text':
    case 'textarea':
    default: {
      const s = toSingleString(raw);
      return s ? s.slice(0, MAX_TEXT_LENGTH) : null;
    }
  }
}

/**
 * Extracts embedded metadata from `buffer` and writes it into
 * `resource_field_data` for every admin-configured `exif_source` mapping that
 * produced a usable value - but only where the resource has no value for
 * that field yet (a human-typed value always wins, same guard shape as the
 * auto-cover feature's `cover_storage_key IS NULL`). Swallows every failure:
 * a bad EXIF block, an unreachable DB row, whatever - this must never fail
 * the upload it's attached to.
 *
 * `uploaderTenantId` scopes which field definitions apply, same rule as
 * every other field-read site added for tenant-scoped metadata: global
 * fields (tenant_id IS NULL) plus the uploader's own tenant's - never
 * another tenant's mapping. Passing `null` (a super admin uploading, or a
 * fail-closed missing-tenant token) naturally narrows this to global-only,
 * since `tenant_id = NULL` is never true in SQL.
 */
export async function applyExtractedMetadata(
  resourceId: string,
  buffer: Buffer,
  mimeType: string,
  uploaderTenantId: string | null,
): Promise<void> {
  try {
    const extracted = await extractMetadata(buffer, mimeType);
    if (Object.keys(extracted).length === 0) return;

    const fields = await db.query<{
      id: number;
      field_type: MetadataFieldType;
      options: string[] | null;
      exif_source: string;
    }>(
      `SELECT id, field_type, options, exif_source
       FROM metadata_fields
       WHERE exif_source IS NOT NULL
         AND (tenant_id IS NULL OR tenant_id = $1)`,
      [uploaderTenantId],
    );

    for (const field of fields.rows) {
      if (!(field.exif_source in extracted)) continue;
      const value = coerceExifValue(extracted[field.exif_source], field.field_type, field.options);
      if (!value) continue;

      await db.query(
        `INSERT INTO resource_field_data (resource_id, field_id, value)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM resource_field_data WHERE resource_id = $1 AND field_id = $2
         )`,
        [resourceId, field.id, value],
      );
    }
  } catch (err) {
    console.error('lib/exif: applyExtractedMetadata failed, ignoring:', err);
  }
}
