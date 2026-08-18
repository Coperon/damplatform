import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, requireAuth, canAccessAllTenants } from '@/lib/session';
import { tenantHasCollectionAccess, hasPermission } from '@/lib/permissions';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  const lookup = await db.query('SELECT id, name FROM collections WHERE id = $1', [id]);
  const collection = lookup.rows[0];
  if (!collection) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Cascade ancestor access check — a grant matches at any level in the chain
  // (Stage 88: was root-only), not just the root. Bypass: cross-tenant users
  // (super admins, and role-2 admins with can_access_all_tenants — the "third branch");
  // everyone else falls through to the same tenant-scoped check as always.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    const accessCheck = await db.query(
      `WITH RECURSIVE root_finder AS (
         SELECT id, parent_id FROM collections WHERE id = $1
         UNION ALL
         SELECT c.id, c.parent_id
         FROM collections c
         INNER JOIN root_finder rf ON rf.parent_id = c.id
         WHERE rf.parent_id IS NOT NULL
       )
       SELECT 1 FROM root_finder rf
       INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.id
       WHERE cca.tenant_id = $2
       LIMIT 1`,
      [id, user.tenantId],
    );
    if (accessCheck.rowCount === 0) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  return NextResponse.json(collection);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Stage 108: floor widened from requireAdmin to requireAuth — the two
  // fields this route accepts now have different gates. 'name' (rename) is
  // the per-tenant 'rename_collection' permission (editor-configurable);
  // 'coverStorageKey' (Change thumbnail) has no permission key at all and
  // stays admin/cross-tenant-tier only, exactly as before this stage — checked
  // per-field below, after the body is parsed.
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  // Tenant-scoped enforcement: a tenant admin (or a permission-granted
  // editor) may rename/re-cover only a collection their tenant can reach —
  // cross-tenant users (super admin, or the can_access_all_tenants flag) bypass this.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId || !(await tenantHasCollectionAccess(user.tenantId, id))) {
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

  if ('name' in body) {
    if (!(await hasPermission(user, 'rename_collection'))) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }
    const v = body.name;
    if (typeof v !== 'string' || !v.trim()) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    params.push(v.trim().slice(0, 255));
    setClauses.push(`name = $${params.length}`);
  }

  if ('coverStorageKey' in body) {
    // No permission key for this — "Change thumbnail" stays fixed
    // admin/cross-tenant-tier capability, unchanged from before Stage 108.
    if (!user.canAdmin && !canAccessAllTenants(user)) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }
    const v = body.coverStorageKey;
    if (typeof v !== 'string' || !v) {
      return NextResponse.json({ error: 'coverStorageKey must be a non-empty string' }, { status: 400 });
    }
    params.push(v);
    setClauses.push(`cover_storage_key = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
  }

  params.push(id);
  const result = await db.query(
    `UPDATE collections SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING id, name`,
    params,
  );
  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(result.rows[0]);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  const lookup = await db.query('SELECT id FROM collections WHERE id = $1', [id]);
  if (lookup.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Tenant-scoped enforcement: a tenant admin may delete only a collection
  // (and its subtree) their tenant can reach — including one Coperon
  // originally created, per the decision. cross-tenant users bypass this.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId || !(await tenantHasCollectionAccess(user.tenantId, id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  // ON DELETE CASCADE on parent_id removes all descendant collections, their
  // collection_resource links, and their group_collection_access/tenant_collection_access
  // rows automatically. resources rows and MinIO bytes are not touched.
  await db.query('DELETE FROM collections WHERE id = $1', [id]);

  return NextResponse.json({ ok: true });
}
