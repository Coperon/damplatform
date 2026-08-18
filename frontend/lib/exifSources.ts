export type MetadataFieldType = 'text' | 'textarea' | 'checkbox_group' | 'tag' | 'date';

export interface ExifSourceDef {
  value: string;
  label: string;
  appliesTo: MetadataFieldType[];
}

// Fixed whitelist of supported auto-fill sources - the only values
// `metadata_fields.exif_source` may ever hold. Never accept a client-supplied
// string here; both the admin API (route validation) and the extractor
// (lib/exif.ts's GETTERS lookup) key off this exact list. GPS is deliberately
// excluded - coordinates are the photographer's location, privacy-sensitive,
// and there is no location field in this schema to hold them.
//
// Pure data/no server deps (no `pg`, no `exifr`) so both the admin UI
// ("use client") and the server-only extraction/validation code in
// lib/exif.ts can import it without pulling server-only modules into the
// client bundle.
export const EXIF_SOURCES: ExifSourceDef[] = [
  { value: 'iptc.ObjectName', label: 'IPTC: Object name', appliesTo: ['text'] },
  { value: 'iptc.Caption-Abstract', label: 'IPTC: Caption / abstract', appliesTo: ['text', 'textarea'] },
  { value: 'iptc.Keywords', label: 'IPTC: Keywords', appliesTo: ['tag', 'checkbox_group'] },
  { value: 'iptc.By-line', label: 'IPTC: By-line (photographer)', appliesTo: ['text'] },
  { value: 'iptc.Credit', label: 'IPTC: Credit', appliesTo: ['text'] },
  { value: 'iptc.Copyright', label: 'IPTC: Copyright notice', appliesTo: ['text'] },
  { value: 'iptc.City', label: 'IPTC: City', appliesTo: ['text'] },
  { value: 'iptc.Country-PrimaryLocationName', label: 'IPTC: Country', appliesTo: ['text'] },
  { value: 'iptc.DateCreated', label: 'IPTC: Date created', appliesTo: ['date'] },
  { value: 'xmp.title', label: 'XMP: Title', appliesTo: ['text'] },
  { value: 'xmp.description', label: 'XMP: Description', appliesTo: ['text', 'textarea'] },
  { value: 'xmp.subject', label: 'XMP: Subject / keywords', appliesTo: ['tag', 'checkbox_group'] },
  { value: 'xmp.creator', label: 'XMP: Creator', appliesTo: ['text'] },
  { value: 'xmp.rights', label: 'XMP: Rights', appliesTo: ['text'] },
  { value: 'exif.DateTimeOriginal', label: 'EXIF: Date taken', appliesTo: ['date'] },
  { value: 'exif.Make', label: 'EXIF: Camera make', appliesTo: ['text'] },
  { value: 'exif.Model', label: 'EXIF: Camera model', appliesTo: ['text'] },
  { value: 'exif.LensModel', label: 'EXIF: Lens model', appliesTo: ['text'] },
  { value: 'exif.ISO', label: 'EXIF: ISO', appliesTo: ['text'] },
  { value: 'exif.FNumber', label: 'EXIF: F-number', appliesTo: ['text'] },
  { value: 'exif.ExposureTime', label: 'EXIF: Exposure time', appliesTo: ['text'] },
  { value: 'exif.FocalLength', label: 'EXIF: Focal length', appliesTo: ['text'] },
  { value: 'exif.ImageWidth', label: 'EXIF: Image width', appliesTo: ['text'] },
  { value: 'exif.ImageHeight', label: 'EXIF: Image height', appliesTo: ['text'] },
];

const EXIF_SOURCE_VALUES = new Set(EXIF_SOURCES.map((s) => s.value));

export function isValidExifSource(value: unknown): value is string {
  return typeof value === 'string' && EXIF_SOURCE_VALUES.has(value);
}

export function exifSourceAppliesTo(source: string, fieldType: MetadataFieldType): boolean {
  const def = EXIF_SOURCES.find((s) => s.value === source);
  return def ? def.appliesTo.includes(fieldType) : false;
}
