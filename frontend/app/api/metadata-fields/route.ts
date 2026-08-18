import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, actingTenantId } from '@/lib/session';
import { isValidExifSource, exifSourceAppliesTo } from '@/lib/exifSources';

const FIELD_TYPES = ['text', 'textarea', 'checkbox_group', 'tag', 'date'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

// `exif_source` is only ever accepted from the fixed whitelist in lib/exif.ts,
// and only when that source applies to this field's type - never free text,
// same principle as `options` being ignored/validated per field_type below.
function parseExifSource(raw: unknown, fieldType: FieldType): string | null | { error: string } {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !isValidExifSource(raw)) {
    return { error: 'exif_source is not a recognized auto-fill source' };
  }
  if (!exifSourceAppliesTo(raw, fieldType)) {
    return { error: 'exif_source does not apply to this field type' };
  }
  return raw;
}

const MAX_OPTIONS = 50;
const MAX_OPTION_LEN = 100;

// Only checkbox_group fields carry an options list. For every other type,
// `options` is ignored if present in the request body (not an error) — the
// column stays NULL, matching the schema comment on metadata_fields.options.
function parseOptions(raw: unknown): string[] | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: 'options must be an array of strings' };
  }
  const cleaned: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { error: 'options must be an array of strings' };
    }
    const trimmed = item.trim().slice(0, MAX_OPTION_LEN);
    if (trimmed) cleaned.push(trimmed);
  }
  if (cleaned.length === 0) {
    return { error: 'options must contain at least one non-empty value' };
  }
  if (cleaned.length > MAX_OPTIONS) {
    return { error: `options cannot exceed ${MAX_OPTIONS} items` };
  }
  return cleaned;
}

// Field-definition management is admin-only (this route backs only the
// admin page, see the grep-confirmed call-site list in the changelog for this
// stage) — a tenant admin manages their own tenant's fields plus a
// read-only view of Coperon's global ones; a super admin manages every
// tenant's fields at once. Regular per-asset field *reading* (the drawer,
// the full-page editor, the upload workflow) goes through
// GET /api/resources/[id]/metadata instead, which applies the same
// global-or-own-tenant visibility rule independently — see that route.
export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  type Row = {
    id: number;
    name: string;
    field_type: string;
    searchable: boolean;
    sort_order: number;
    options: string[] | null;
    required: boolean;
    exif_source: string | null;
    tenant_id: string | null;
    tenant_name: string | null;
  };

  // Global fields first (by sort_order), then tenant fields grouped by
  // tenant (by sort_order within each) — the one ordering convention every
  // field-read site in this app now shares, see the "Conventions" note added
  // for this stage. A super admin's tenant_id param is null, which — since
  // `tenant_id = NULL` is never true in SQL — makes the `OR` collapse to
  // exactly `tenant_id IS NULL`, so the same query text also naturally
  // becomes "all fields" only when we skip the WHERE for a super admin below.
  if (isSuperAdmin(user)) {
    const result = await db.query<Row>(
      `SELECT mf.id, mf.name, mf.field_type, mf.searchable, mf.sort_order, mf.options,
              mf.required, mf.exif_source, mf.tenant_id, c.name AS tenant_name
       FROM metadata_fields mf
       LEFT JOIN tenants c ON c.id = mf.tenant_id
       ORDER BY (mf.tenant_id IS NOT NULL), mf.tenant_id, mf.sort_order, mf.id`,
    );
    return NextResponse.json(result.rows);
  }

  // Non-super admins: global + one tenant's fields — for a cross-tenant admin
  // that's the tenant they're acting as (the switcher cookie, defaulting to
  // their own); for a regular tenant admin it's always their own tenant (a
  // cookie is silently ignored). Fails closed (empty list, not an error) if
  // no tenant resolves, same convention as every other tenant-scoped read.
  const effectiveTenant = actingTenantId(user, req);
  if (!effectiveTenant) {
    return NextResponse.json([]);
  }
  const result = await db.query<Row>(
    `SELECT mf.id, mf.name, mf.field_type, mf.searchable, mf.sort_order, mf.options,
            mf.required, mf.exif_source, mf.tenant_id, c.name AS tenant_name
     FROM metadata_fields mf
     LEFT JOIN tenants c ON c.id = mf.tenant_id
     WHERE mf.tenant_id IS NULL OR mf.tenant_id = $1
     ORDER BY (mf.tenant_id IS NOT NULL), mf.tenant_id, mf.sort_order, mf.id`,
    [effectiveTenant],
  );
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) {
    return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
  }

  let fieldType: FieldType = 'text';
  if ('fieldType' in body) {
    if (typeof body.fieldType !== 'string' || !FIELD_TYPES.includes(body.fieldType as FieldType)) {
      return NextResponse.json(
        { error: `fieldType must be one of: ${FIELD_TYPES.join(', ')}` },
        { status: 400 },
      );
    }
    fieldType = body.fieldType as FieldType;
  }

  const searchable = 'searchable' in body ? Boolean(body.searchable) : true;
  const required = 'required' in body ? Boolean(body.required) : false;

  let options: string[] | null = null;
  if (fieldType === 'checkbox_group') {
    const parsed = parseOptions(body.options);
    if (!Array.isArray(parsed)) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    options = parsed;
  }

  const parsedExifSource = parseExifSource(body.exifSource, fieldType);
  if (parsedExifSource !== null && typeof parsedExifSource === 'object') {
    return NextResponse.json({ error: parsedExifSource.error }, { status: 400 });
  }

  // Scope: a non-super admin's field always belongs to the tenant they're
  // acting as — for a cross-tenant admin that's the switcher tenant (they may
  // create fields for any tenant they're navigating as, but NEVER a global
  // field: creating/editing global definitions stays super-admin-only, per
  // the cross-tenant-access exceptions list); for a regular tenant admin it's always
  // their own tenant. Any tenantId in the request body is silently
  // overridden, the same discipline POST /api/invitations uses. A super
  // admin may create a global field (default, tenant_id NULL) or one scoped
  // to a specific tenant — validated to actually exist.
  let tenantId: string | null;
  if (isSuperAdmin(user)) {
    if ('tenantId' in body && body.tenantId !== null && body.tenantId !== undefined) {
      if (typeof body.tenantId !== 'string') {
        return NextResponse.json({ error: 'tenantId must be a string' }, { status: 400 });
      }
      const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1', [body.tenantId]);
      if (tenantCheck.rowCount === 0) {
        return NextResponse.json({ error: 'tenantId does not exist' }, { status: 400 });
      }
      tenantId = body.tenantId;
    } else {
      tenantId = null;
    }
  } else {
    const effectiveTenant = actingTenantId(user, req);
    if (!effectiveTenant) {
      return NextResponse.json({ error: 'No company on this account' }, { status: 403 });
    }
    tenantId = effectiveTenant;
  }

  try {
    const result = await db.query(
      `INSERT INTO metadata_fields (name, field_type, searchable, options, required, exif_source, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, field_type, searchable, sort_order, options, required, exif_source, tenant_id`,
      [name, fieldType, searchable, options === null ? null : JSON.stringify(options), required, parsedExifSource, tenantId],
    );
    return NextResponse.json(result.rows[0], { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
      return NextResponse.json({ error: 'A field with that name already exists' }, { status: 409 });
    }
    throw err;
  }
}
