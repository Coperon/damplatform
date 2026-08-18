import { canAccessAllTenants } from '@/lib/session';
import { AppError } from '@/lib/errors';
import {
  tenantHasResourceAccess,
  tenantHasCollectionAccess,
  requirePermission,
} from '@/lib/permissions';
import db from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // Stage 108: was requireAdmin — now the per-tenant 'add_to_collection'
  // permission (default OFF for editors — correcting an easy-to-assume-wrong
  // guess that this was already on since remove_from_collection is; on disk
  // it was requireAdmin-only, so it's a genuinely new editor capability,
  // opt-in per tenant).
  const user = await requirePermission(request, 'add_to_collection');
  if (user instanceof Response) return user;

  try {
    const { id: resourceId } = await ctx.params;

    if (!UUID_RE.test(resourceId)) {
      return Response.json({ message: 'resource id in URL must be a valid uuid' }, { status: 400 });
    }

    const body = await request.json();
    const { collectionId } = body;

    if (typeof collectionId !== 'string' || !UUID_RE.test(collectionId)) {
      return Response.json({ message: 'collectionId is required and must be a valid uuid' }, { status: 400 });
    }

    const resourceCheck = await db.query('SELECT id FROM resources WHERE id = $1', [resourceId]);
    if (resourceCheck.rowCount === 0) {
      return Response.json({ message: 'Resource not found' }, { status: 404 });
    }

    const collectionCheck = await db.query('SELECT id FROM collections WHERE id = $1', [collectionId]);
    if (collectionCheck.rowCount === 0) {
      return Response.json({ message: 'Collection not found' }, { status: 404 });
    }

    // Tenant-scoped enforcement: a tenant admin may link a resource into a
    // collection only when BOTH sides are within their tenant's reach — the
    // resource (via tenantHasResourceAccess, same cascade the media list and
    // rename/delete/thumbnail routes reuse) and the target collection (via
    // tenantHasCollectionAccess, same as collection create/rename/delete).
    // Checking only one side would let a tenant admin either pull in a
    // resource they don't own (checking only the collection) or expose their
    // own resource into a collection they don't control (checking only the
    // resource) — this is exactly the cross-tenant exposure the original
    // Stage 6 super-admin-only classification of this route was guarding
    // against. cross-tenant users (super admin, or can_access_all_tenants) bypass both checks.
    if (!canAccessAllTenants(user)) {
      if (!user.tenantId) {
        return Response.json({ message: 'Access denied' }, { status: 403 });
      }
      const [resourceReachable, collectionReachable] = await Promise.all([
        tenantHasResourceAccess(user.tenantId, resourceId),
        tenantHasCollectionAccess(user.tenantId, collectionId),
      ]);
      if (!resourceReachable || !collectionReachable) {
        return Response.json({ message: 'Access denied' }, { status: 403 });
      }
    }

    const insert = await db.query(
      `INSERT INTO collection_resource (collection_id, resource_id)
       VALUES ($1, $2)
       ON CONFLICT (collection_id, resource_id) DO NOTHING
       RETURNING collection_id`,
      [collectionId, resourceId],
    );

    return Response.json({ ok: true, added: (insert.rowCount ?? 0) > 0 });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
