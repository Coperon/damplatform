import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, canAccessAllTenants } from '@/lib/session';
import { isValidExifSource, exifSourceAppliesTo } from '@/lib/exifSources';

const FIELD_TYPES = ['text', 'textarea', 'checkbox_group', 'tag', 'date'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

// See app/api/metadata-fields/route.ts for the exif_source contract: only a
// whitelisted value that applies to the (possibly just-changed) field type.
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

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// See app/api/metadata-fields/route.ts for the options contract: only
// checkbox_group fields carry a value; every other type keeps it NULL.
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

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'Invalid field id' }, { status: 400 });
  }

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

  const existing = await db.query<{ field_type: FieldType; exif_source: string | null; tenant_id: string | null }>(
    'SELECT field_type, exif_source, tenant_id FROM metadata_fields WHERE id = $1',
    [id],
  );
  if (existing.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const currentType = existing.rows[0].field_type;
  const currentExifSource = existing.rows[0].exif_source;
  const ownerTenantId = existing.rows[0].tenant_id;

  // Ownership: a super admin may modify any field. A cross-tenant admin may
  // modify ANY tenant's field but NEVER a global one — editing global
  // definitions is on the cross-tenant-access exceptions list, super-admin-only. A
  // regular tenant admin may only modify their own tenant's fields. 403,
  // not 404, so this is distinguishable from "field doesn't exist."
  if (!isSuperAdmin(user)) {
    if (ownerTenantId === null) {
      return NextResponse.json({ error: 'Cannot modify this field' }, { status: 403 });
    }
    if (!canAccessAllTenants(user) && ownerTenantId !== user.tenantId) {
      return NextResponse.json({ error: 'Cannot modify this field' }, { status: 403 });
    }
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if ('name' in body) {
    const v = body.name;
    if (typeof v !== 'string' || !v.trim()) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    params.push(v.trim().slice(0, 100));
    setClauses.push(`name = $${params.length}`);
  }

  let newFieldType: FieldType | null = null;
  if ('fieldType' in body) {
    const v = body.fieldType;
    if (typeof v !== 'string' || !FIELD_TYPES.includes(v as FieldType)) {
      return NextResponse.json(
        { error: `fieldType must be one of: ${FIELD_TYPES.join(', ')}` },
        { status: 400 },
      );
    }
    newFieldType = v as FieldType;
    params.push(v);
    setClauses.push(`field_type = $${params.length}`);
  }

  if ('searchable' in body) {
    params.push(Boolean(body.searchable));
    setClauses.push(`searchable = $${params.length}`);
  }

  if ('required' in body) {
    params.push(Boolean(body.required));
    setClauses.push(`required = $${params.length}`);
  }

  if ('sortOrder' in body) {
    const v = body.sortOrder;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 });
    }
    params.push(v);
    setClauses.push(`sort_order = $${params.length}`);
  }

  const effectiveType = newFieldType ?? currentType;

  if ('options' in body) {
    if (effectiveType === 'checkbox_group') {
      const parsed = parseOptions(body.options);
      if (!Array.isArray(parsed)) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      params.push(JSON.stringify(parsed));
      setClauses.push(`options = $${params.length}`);
    }
    // options provided but the effective type isn't checkbox_group — ignored,
    // not an error (mirrors POST's ignore-for-other-types behavior).
  } else if (newFieldType && newFieldType !== 'checkbox_group') {
    // Switching away from checkbox_group without explicitly setting options
    // in the same request — clear the stale list so it stays NULL for the
    // new type, matching the schema comment.
    setClauses.push(`options = NULL`);
  }

  if ('exifSource' in body) {
    const parsed = parseExifSource(body.exifSource, effectiveType);
    if (parsed !== null && typeof parsed === 'object') {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    params.push(parsed);
    setClauses.push(`exif_source = $${params.length}`);
  } else if (newFieldType && currentExifSource && !exifSourceAppliesTo(currentExifSource, newFieldType)) {
    // Switching field type without touching exif_source: if the existing
    // mapping no longer applies to the new type (mirrors the options-clear
    // above), clear it rather than leaving a stale, now-invalid source.
    setClauses.push(`exif_source = NULL`);
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
  }

  params.push(id);

  try {
    const result = await db.query(
      `UPDATE metadata_fields SET ${setClauses.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, field_type, searchable, sort_order, options, required, exif_source, tenant_id`,
      params,
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(result.rows[0]);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
      return NextResponse.json({ error: 'A field with that name already exists' }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'Invalid field id' }, { status: 400 });
  }

  // Same ownership rule as PATCH — a cross-tenant admin may delete any tenant's
  // field but never a global one; a regular tenant admin only their own
  // tenant's.
  if (!isSuperAdmin(user)) {
    const existing = await db.query<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM metadata_fields WHERE id = $1',
      [id],
    );
    if (existing.rowCount === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const ownerTenantId = existing.rows[0].tenant_id;
    if (ownerTenantId === null) {
      return NextResponse.json({ error: 'Cannot modify this field' }, { status: 403 });
    }
    if (!canAccessAllTenants(user) && ownerTenantId !== user.tenantId) {
      return NextResponse.json({ error: 'Cannot modify this field' }, { status: 403 });
    }
  }

  // ON DELETE CASCADE on resource_field_data.field_id removes every stored
  // per-asset value for this field automatically — this affects only that
  // field's own values (rows keyed by this specific field_id), so a tenant
  // admin deleting their own field can never touch another tenant's or
  // Coperon's data, cascade or not.
  const result = await db.query('DELETE FROM metadata_fields WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
