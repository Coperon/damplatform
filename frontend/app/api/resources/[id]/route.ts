import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAuth, canAccessAllTenants } from '@/lib/session';
import { deleteObject } from '@/lib/storage';
import {
  canEditResourceMetadata,
  tenantHasResourceAccess,
  requirePermission,
} from '@/lib/permissions';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  const result = await db.query(
    'SELECT id, original_filename, mime_type, size_bytes, thumbnail_storage_key FROM resources WHERE id = $1',
    [id],
  );

  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Feeds the metadata editor's asset preview — same scope as who may author
  // metadata on this resource (admin, or an editor whose group can reach it).
  // Viewers never reach this endpoint (the metadata page is admin/editor-only).
  if (!(await canEditResourceMetadata(user, id))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  return NextResponse.json(result.rows[0]);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Stage 108: was requireAdmin — now the per-tenant 'rename_asset'
  // permission (still always true for admin tiers, so no admin behavior
  // change; editors reach this only when their tenant has enabled it).
  // Descriptions stay effectively admin-authored in the UI (the inline
  // description editor is only rendered for canAdmin), but the permission
  // boundary here is rename_asset for the whole PATCH — a tenant that
  // enables rename_asset for editors is delegating asset labeling, and
  // filename vs. description are the same trust level.
  const user = await requirePermission(req, 'rename_asset');
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  // Tenant-scoped enforcement: a tenant admin (or a permission-granted
  // editor) may rename/re-describe only an asset their tenant can reach —
  // cross-tenant users bypass this.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId || !(await tenantHasResourceAccess(user.tenantId, id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
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

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if ('originalFilename' in body) {
    const v = body.originalFilename;
    if (typeof v !== 'string' || !v.trim()) {
      return NextResponse.json({ error: 'originalFilename must be a non-empty string' }, { status: 400 });
    }
    params.push(v.trim().slice(0, 255));
    setClauses.push(`original_filename = $${params.length}`);
  }

  if ('description' in body) {
    const v = body.description;
    if (typeof v !== 'string') {
      return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
    }
    params.push(v || null);
    setClauses.push(`description = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
  }

  params.push(id);
  const result = await db.query(
    `UPDATE resources SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING id, original_filename, description`,
    params,
  );

  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(result.rows[0]);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Stage 108: was requireAdmin — now the per-tenant 'delete_permanently'
  // permission (default OFF for editors, always true for admin tiers).
  const user = await requirePermission(req, 'delete_permanently');
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  const lookup = await db.query<{ storage_key: string; thumbnail_storage_key: string | null }>(
    'SELECT storage_key, thumbnail_storage_key FROM resources WHERE id = $1',
    [id],
  );
  if (lookup.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { storage_key: storageKey, thumbnail_storage_key: thumbnailStorageKey } = lookup.rows[0];

  // Tenant-scoped enforcement: a tenant admin may permanently delete only
  // an asset their tenant can reach — including one Coperon uploaded into
  // one of their collections, per the decision. A true super admin bypasses
  // this. Editors never reach this route at all: requireAdmin above already
  // excludes role 3 (canAdmin: false), so no additional editor-specific
  // exclusion is needed here. cross-tenant users bypass (the "third branch").
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId || !(await tenantHasResourceAccess(user.tenantId, id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  // Clear any collection cover pointing at this resource's file (image or
  // generated thumbnail) before the row and object are gone — otherwise the
  // collection would point at a missing object forever.
  await db.query(
    'UPDATE collections SET cover_storage_key = NULL WHERE cover_storage_key IN ($1, $2)',
    [storageKey, thumbnailStorageKey],
  );

  // Delete DB row first — ON DELETE CASCADE removes all collection_resource links
  await db.query('DELETE FROM resources WHERE id = $1', [id]);

  // Then delete bytes from MinIO — orphaned storage object is acceptable, don't surface to user
  try {
    await deleteObject(storageKey);
  } catch (err) {
    console.error('MinIO delete failed for key', storageKey, err);
  }

  return NextResponse.json({ ok: true });
}
