import { requireAuth, canAccessAllTenants } from '@/lib/session';
import { AppError } from '@/lib/errors';
import db from '@/lib/db';

// Whitelisted page sizes — pageSize is validated against this list, never
// taken from the request as-is.
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(request);
  if (user instanceof Response) return user;

  try {
    const { id } = await ctx.params;

    const { searchParams } = new URL(request.url);

    // pageSize — whitelist lookup; unrecognised values fall back to the default
    const pageSizeRaw = Number(searchParams.get('pageSize'));
    const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE;

    const requestedPageRaw = Number(searchParams.get('page'));
    const requestedPage = Number.isInteger(requestedPageRaw) && requestedPageRaw >= 1 ? requestedPageRaw : 1;

    // Unscoped visibility is a cross-tenant-user bypass (super admin, or role-2
    // + can_access_all_tenants — the "third branch") — a regular tenant admin falls
    // through to the same tenant-scoped cascade check below, unchanged.
    if (canAccessAllTenants(user)) {
      // total — identical FROM/JOIN/WHERE as the page query below, just counted
      // instead of selected/limited, so it reflects the same filtered set.
      const countResult = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM resources r
         INNER JOIN collection_resource cr ON cr.resource_id = r.id
         WHERE cr.collection_id = $1`,
        [id],
      );
      const total = countResult.rows[0]?.total ?? 0;

      // Clamp: a page past the end returns the last page's rows instead of an
      // empty result — a stale page number from a shrinking result set steps
      // back rather than showing a blank grid with a nonzero total.
      const lastPage = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, lastPage);
      const offset = (page - 1) * pageSize;

      const result = await db.query(
        `SELECT r.id, r.original_filename, r.mime_type, r.size_bytes, r.status, r.description, r.thumbnail_storage_key
         FROM resources r
         INNER JOIN collection_resource cr ON cr.resource_id = r.id
         WHERE cr.collection_id = $1
         ORDER BY r.created_at DESC
         LIMIT $2 OFFSET $3`,
        [id, pageSize, offset],
      );
      return Response.json({ files: result.rows, total, page, pageSize });
    }

    // Non-admins: cascade ancestor access check — a grant matches at any level in
    // the chain (Stage 88: was root-only). Walk from this collection upward
    // through parent_id and check whether any ancestor (inclusive) is granted to
    // the user's tenant. Return [] on no access — do not leak files.
    // Fail closed: no tenant (old token, or a data anomaly) skips the query entirely.
    if (!user.tenantId) {
      return Response.json({ files: [], total: 0, page: 1, pageSize });
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
      return Response.json({ files: [], total: 0, page: 1, pageSize });
    }

    // total — identical FROM/JOIN/WHERE as the page query below, just counted
    // instead of selected/limited, so it reflects the same filtered set.
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM resources r
       INNER JOIN collection_resource cr ON cr.resource_id = r.id
       WHERE cr.collection_id = $1`,
      [id],
    );
    const total = countResult.rows[0]?.total ?? 0;

    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, lastPage);
    const offset = (page - 1) * pageSize;

    const result = await db.query(
      `SELECT r.id, r.original_filename, r.mime_type, r.size_bytes, r.status, r.description, r.thumbnail_storage_key
       FROM resources r
       INNER JOIN collection_resource cr ON cr.resource_id = r.id
       WHERE cr.collection_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, pageSize, offset],
    );
    return Response.json({ files: result.rows, total, page, pageSize });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
