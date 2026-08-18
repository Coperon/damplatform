import { canAccessAllTenants } from '@/lib/session';
import { getDownloadUrl } from '@/lib/storage';
import { AppError } from '@/lib/errors';
import { logAccess } from '@/lib/accessLog';
import { requirePermission } from '@/lib/permissions';
import db from '@/lib/db';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Stage 108: was requireDownload (role-derived canDownload) — now the
  // per-tenant 'download' permission. Editors keep download unconditionally
  // (it's viewer-configurable only — an editor's baseline already included
  // it); a pending user (role 5) still ends at 403 via hasPermission's
  // fall-through, same net result as the old canDownload gate.
  const user = await requirePermission(request, 'download');
  if (user instanceof Response) return user;

  try {
    const { id } = await ctx.params;

    const result = await db.query(
      'SELECT id, original_filename, storage_key, mime_type, status FROM resources WHERE id = $1',
      [id],
    );
    const resource = result.rows[0];
    if (!resource) {
      return Response.json({ message: 'Resource not found' }, { status: 404 });
    }

    // Non-admins: verify the user's tenant can access at least one collection this
    // file belongs to. Walk each owning collection upward through parent_id and
    // check tenant_collection_access at any level in that chain — not just the
    // root (Stage 88: was root-only). A file in no accessible collection is
    // denied — this closes the gap where any canDownload user could fetch by id.
    // Fail closed: no tenant (old token, or a data anomaly) means no query, zero access.
    // cross-tenant users (super admin, or role-2 + can_access_all_tenants) bypass this —
    // everyone else must pass the same tenant-scoped check below.
    if (!canAccessAllTenants(user)) {
      if (!user.tenantId) {
        return Response.json({ message: 'Access denied' }, { status: 403 });
      }
      const accessCheck = await db.query(
        `WITH RECURSIVE root_finder AS (
           SELECT c.id, c.parent_id
           FROM collections c
           INNER JOIN collection_resource cr ON cr.collection_id = c.id
           WHERE cr.resource_id = $1
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
        return Response.json({ message: 'Access denied' }, { status: 403 });
      }
    }

    const downloadUrl = await getDownloadUrl(resource.storage_key);

    // Fire-and-forget access-log write — access is already authorized at this
    // point (never reached on a 403 above), so this is a real, allowed serve.
    // Not awaited: a logging failure must never affect the download itself.
    logAccess({
      userId: user.sub,
      tenantId: user.tenantId ?? null,
      resourceId: id,
      action: 'download',
    });

    return Response.json({
      downloadUrl,
      filename: resource.original_filename,
      mimeType: resource.mime_type,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
