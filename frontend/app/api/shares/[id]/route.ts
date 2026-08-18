import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, canAccessAllTenants } from '@/lib/session';
import { tenantHasCollectionAccess, tenantHasResourceAccess } from '@/lib/permissions';

// Shared by PATCH/DELETE below: fetches the share's target columns and, for a
// non-super-admin, verifies their tenant can reach that target — the same
// two cascade helpers every other newly-scoped route reuses, not a second
// access path. Returns the Response to send instead if the share is missing
// or unreachable, or null if the caller may proceed.
async function loadShareAndCheckAccess(
  id: string,
  user: { tenantId?: string | null },
  bypass: boolean, // cross-tenant users (super admin, or role-2 + can_access_all_tenants)
): Promise<NextResponse | null> {
  const lookup = await db.query<{ collection_id: string | null; resource_id: string | null }>(
    'SELECT collection_id, resource_id FROM shares WHERE id = $1',
    [id],
  );
  if (lookup.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (bypass) return null;

  const { collection_id: collectionId, resource_id: resourceId } = lookup.rows[0];
  if (!user.tenantId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }
  const reachable = collectionId
    ? await tenantHasCollectionAccess(user.tenantId, collectionId)
    : await tenantHasResourceAccess(user.tenantId, resourceId!);
  if (!reachable) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }
  return null;
}

// Revoke only — scope (target/access level) is immutable by design. A changed
// share should be created as a new share, not edited in place.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

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

  if (body.revoked !== true) {
    return NextResponse.json({ error: 'Only { revoked: true } is supported' }, { status: 400 });
  }

  // Tenant-scoped enforcement: a tenant admin may revoke only a share
  // whose target their tenant can reach — cross-tenant users bypass this.
  const denied = await loadShareAndCheckAccess(id, user, canAccessAllTenants(user));
  if (denied) return denied;

  const result = await db.query('UPDATE shares SET revoked = true WHERE id = $1 RETURNING id', [id]);
  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  // Tenant-scoped enforcement: a tenant admin may delete only a share
  // whose target their tenant can reach — cross-tenant users bypass this.
  const denied = await loadShareAndCheckAccess(id, user, canAccessAllTenants(user));
  if (denied) return denied;

  const result = await db.query('DELETE FROM shares WHERE id = $1 RETURNING id', [id]);
  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
