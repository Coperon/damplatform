import { requireAuth, isSuperAdmin, actingTenantId } from '@/lib/session';
import db from '@/lib/db';
import { AppError } from '@/lib/errors';

const LIMIT = 20;
const MAX_Q_LEN = 100;

export async function GET(request: Request) {
  const user = requireAuth(request);
  if (user instanceof Response) return user;

  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get('q');

    if (!raw || !raw.trim()) {
      return Response.json({ message: 'q is required' }, { status: 400 });
    }
    const term = raw.trim().slice(0, MAX_Q_LEN);

    let collections: unknown[];
    let files: unknown[];

    // cross-tenant admins search as the tenant they're acting as (the switcher
    // cookie, defaulting to their own tenant) — never the unscoped
    // super-admin view; everyone else searches as their own tenant.
    const effectiveTenant = actingTenantId(user, request);

    // Stage 6: unscoped cross-tenant search is a super-admin-only bypass — a
    // tenant admin also has canAdmin: true but must fall through to the
    // same tenant-scoped cascade below, same as an editor/viewer.
    if (isSuperAdmin(user)) {
      const [colResult, fileResult] = await Promise.all([
        db.query(
          `SELECT id, name, parent_id
           FROM collections
           WHERE name ILIKE '%' || $1 || '%'
           ORDER BY name
           LIMIT $2`,
          [term, LIMIT],
        ),
        db.query(
          // A super admin has no tenant, so their visible metadata-field
          // scope here is global-only (mf.tenant_id IS NULL) — same rule as
          // GET /api/resources/[id]/metadata, just hardcoded since this
          // branch has no tenantId to parameterize. Cross-tenant search
          // still returns every tenant's collections/files (super admin's
          // usual unscoped bypass) — only the *metadata-value* match is
          // scope-limited, so this never matches on a value stored against
          // a tenant-owned field the super admin can't otherwise see.
          `WITH matched AS (
             SELECT DISTINCT ON (r.id)
               r.id, r.original_filename, r.mime_type, r.size_bytes, r.description,
               cr.collection_id,
               ts_rank(r.search_vector, websearch_to_tsquery('english', $1)) AS rank
             FROM resources r
             INNER JOIN collection_resource cr ON cr.resource_id = r.id
             WHERE r.search_vector @@ websearch_to_tsquery('english', $1)
                OR r.original_filename ILIKE '%' || $1 || '%'
                OR EXISTS (
                  SELECT 1
                  FROM resource_field_data rfd
                  INNER JOIN metadata_fields mf ON mf.id = rfd.field_id
                  WHERE rfd.resource_id = r.id
                    AND mf.searchable = true
                    AND mf.tenant_id IS NULL
                    AND rfd.value ILIKE '%' || $1 || '%'
                )
             ORDER BY r.id, cr.collection_id
           )
           SELECT id, original_filename, mime_type, size_bytes, description, collection_id
           FROM matched
           ORDER BY rank DESC, id
           LIMIT $2`,
          [term, LIMIT],
        ),
      ]);
      collections = colResult.rows;
      files = fileResult.rows;
    } else if (!effectiveTenant) {
      // Fail closed: no tenant (old token, or a data anomaly) means no query
      // at all, not a query that would silently match nothing (or everything).
      collections = [];
      files = [];
    } else {
      // Non-admin: both queries share the same accessible-collections logic.
      // root_finder walks every collection upward through parent_id, enumerating
      // every ancestor at every depth (not just the final root) for each
      // original_id. The accessible CTE then keeps original_ids where a grant
      // matches ANY step in that walk — at any level, not just the root
      // (Stage 88: was root-only, filtered to `current_parent IS NULL`). This is
      // the same pattern as GET /api/collections.
      const [colResult, fileResult] = await Promise.all([
        db.query(
          `WITH RECURSIVE root_finder AS (
             SELECT id AS original_id, id AS current_id, parent_id AS current_parent
             FROM collections
             UNION ALL
             SELECT rf.original_id, c.id, c.parent_id
             FROM root_finder rf
             INNER JOIN collections c ON c.id = rf.current_parent
             WHERE rf.current_parent IS NOT NULL
           ),
           accessible AS (
             SELECT DISTINCT rf.original_id AS collection_id
             FROM root_finder rf
             INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.current_id
             WHERE cca.tenant_id = $1
           )
           SELECT c.id, c.name, c.parent_id
           FROM collections c
           INNER JOIN accessible ac ON ac.collection_id = c.id
           WHERE c.name ILIKE '%' || $2 || '%'
           ORDER BY c.name
           LIMIT $3`,
          [effectiveTenant, term, LIMIT],
        ),
        db.query(
          `WITH RECURSIVE root_finder AS (
             SELECT id AS original_id, id AS current_id, parent_id AS current_parent
             FROM collections
             UNION ALL
             SELECT rf.original_id, c.id, c.parent_id
             FROM root_finder rf
             INNER JOIN collections c ON c.id = rf.current_parent
             WHERE rf.current_parent IS NOT NULL
           ),
           accessible AS (
             SELECT DISTINCT rf.original_id AS collection_id
             FROM root_finder rf
             INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.current_id
             WHERE cca.tenant_id = $1
           ),
           matched AS (
             SELECT DISTINCT ON (r.id)
               r.id, r.original_filename, r.mime_type, r.size_bytes, r.description,
               cr.collection_id,
               ts_rank(r.search_vector, websearch_to_tsquery('english', $2)) AS rank
             FROM resources r
             INNER JOIN collection_resource cr ON cr.resource_id = r.id
             INNER JOIN accessible ac ON ac.collection_id = cr.collection_id
             WHERE r.search_vector @@ websearch_to_tsquery('english', $2)
                OR r.original_filename ILIKE '%' || $2 || '%'
                OR EXISTS (
                  SELECT 1
                  FROM resource_field_data rfd
                  INNER JOIN metadata_fields mf ON mf.id = rfd.field_id
                  WHERE rfd.resource_id = r.id
                    AND mf.searchable = true
                    AND (mf.tenant_id IS NULL OR mf.tenant_id = $1)
                    AND rfd.value ILIKE '%' || $2 || '%'
                )
             ORDER BY r.id, cr.collection_id
           )
           SELECT id, original_filename, mime_type, size_bytes, description, collection_id
           FROM matched
           ORDER BY rank DESC, id
           LIMIT $3`,
          [effectiveTenant, term, LIMIT],
        ),
      ]);
      collections = colResult.rows;
      files = fileResult.rows;
    }

    return Response.json({ collections, files });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
