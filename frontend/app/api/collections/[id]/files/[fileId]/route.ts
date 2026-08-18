import { canAccessAllTenants } from '@/lib/session';
import { AppError } from '@/lib/errors';
import { requirePermission } from '@/lib/permissions';
import db from '@/lib/db';

// Fix (separate from the Stage 6 tenant-admin widening pass): this route was
// gated only by requireAuth, meaning any authenticated user who could reach a
// collection — including a viewer — could unlink a file from it. Removing a
// file from a collection is a mutation, not a read, so it needs the same
// canUpload floor upload/rename/etc. already carry; a viewer keeps read-only
// access everywhere else, including this collection's own file list.
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; fileId: string }> },
) {
  // Stage 108: was requireUpload — now the per-tenant 'remove_from_collection'
  // permission, resolved from the DB per request.
  const user = await requirePermission(request, 'remove_from_collection');
  if (user instanceof Response) return user;

  try {
    const { id, fileId } = await ctx.params;

    // Cascade ancestor access check — a grant matches at any level in the
    // chain (Stage 88: was root-only). Walk from this collection upward
    // through parent_id and check whether any ancestor (inclusive) is granted
    // to the user's tenant. cross-tenant users (super admin, or can_access_all_tenants)
    // bypass this — everyone else must pass the check.
    // Fail closed: no tenant (old token, or a data anomaly) means no query, zero access.
    if (!canAccessAllTenants(user)) {
      if (!user.tenantId) {
        return Response.json({ message: 'Access to collection denied' }, { status: 403 });
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
        return Response.json({ message: 'Access to collection denied' }, { status: 403 });
      }
    }

    await db.query(
      `DELETE FROM collection_resource WHERE collection_id = $1 AND resource_id = $2`,
      [id, fileId],
    );

    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
