import { requireAuth, isSuperAdmin, canAccessAllTenants, actingTenantId } from '@/lib/session';
import db from '@/lib/db';
import { AppError } from '@/lib/errors';
import { tenantHasCollectionAccess, requirePermission } from '@/lib/permissions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  // Stage 108: was requireAdmin — now the per-tenant 'create_collection'
  // permission (default OFF for editors, always true for admin tiers). The
  // rest of this handler already branches purely on isSuperAdmin/canAccessAllTenants,
  // not on a second admin-only assumption, so a permission-granted editor
  // flows through the exact same top-level/sub-collection paths a tenant
  // admin already does — auto-granted to their own (or acting) tenant.
  const user = await requirePermission(request, 'create_collection');
  if (user instanceof Response) return user;

  const superAdmin = isSuperAdmin(user);

  try {
    const body = await request.json();
    const { name, tenantIds, parentId } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return Response.json({ message: 'name is required' }, { status: 400 });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (parentId !== undefined && parentId !== null) {
        // Sub-collection path: validate parent exists, then insert with parent_id.
        // No tenant_collection_access rows — access is inherited from the root ancestor.
        if (typeof parentId !== 'string') {
          return Response.json({ message: 'parentId must be a string' }, { status: 400 });
        }
        const parentCheck = await client.query(
          'SELECT id FROM collections WHERE id = $1',
          [parentId],
        );
        if (parentCheck.rowCount === 0) {
          await client.query('ROLLBACK');
          return Response.json({ message: 'Parent collection not found' }, { status: 404 });
        }

        // Tenant-scoped enforcement: a tenant admin may only create a
        // sub-collection under a parent their tenant can already reach —
        // never under an arbitrary collection id. cross-tenant users (super
        // admin, or role-2 + can_access_all_tenants) bypass this.
        if (!canAccessAllTenants(user)) {
          if (!user.tenantId || !(await tenantHasCollectionAccess(user.tenantId, parentId))) {
            await client.query('ROLLBACK');
            return Response.json({ message: 'Access to parent collection denied' }, { status: 403 });
          }
        }

        const result = await client.query(
          'INSERT INTO collections (name, owner_id, parent_id) VALUES ($1, $2, $3) RETURNING *',
          [name.trim(), user.sub, parentId],
        );
        await client.query('COMMIT');
        return Response.json(result.rows[0], { status: 201 });
      }

      // Top-level collection path. Grants now go to tenant_collection_access
      // (Stage 87) — group_collection_access is no longer written anywhere.
      //
      // Tenant-scoped enforcement: a tenant admin's new top-level collection
      // is auto-granted to their own tenant only — the request body's
      // tenantIds is never honored for them, never widened, and never lets
      // them grant anyone else (mirrors POST /api/invitations forcing
      // tenantId from the token instead of the body). A super admin keeps
      // full control over an arbitrary tenant set.
      let requestedIds: string[];
      if (!superAdmin) {
        // A cross-tenant admin's new collection is granted to the tenant they're
        // acting as (the switcher cookie, defaulting to their own tenant) —
        // they can widen the grant set afterward via the Access modal, which
        // they hold full rights to. A regular tenant admin's actingTenantId
        // is always just their own tenant, unchanged.
        const effectiveTenant = actingTenantId(user, request);
        if (!effectiveTenant) {
          await client.query('ROLLBACK');
          return Response.json({ message: 'Your account has no company to grant access to' }, { status: 403 });
        }
        requestedIds = [effectiveTenant];
      } else {
        if (!Array.isArray(tenantIds) || !tenantIds.every((c) => typeof c === 'string' && UUID_RE.test(c))) {
          return Response.json({ message: 'tenantIds must be an array of uuids' }, { status: 400 });
        }
        requestedIds = [...new Set(tenantIds as string[])];
      }

      // Fail closed on an unknown tenant id — reject (400), never insert a
      // grant against an id that doesn't exist. Same validate-before-write
      // pattern as PUT /api/collections/[id]/access.
      const validTenants = await client.query<{ id: string }>('SELECT id FROM tenants');
      const validIds = new Set(validTenants.rows.map((r) => r.id));
      const invalid = requestedIds.filter((cid) => !validIds.has(cid));
      if (invalid.length > 0) {
        await client.query('ROLLBACK');
        return Response.json(
          { message: `Unknown company id(s): ${invalid.join(', ')}` },
          { status: 400 },
        );
      }

      const result = await client.query(
        'INSERT INTO collections (name, owner_id) VALUES ($1, $2) RETURNING *',
        [name.trim(), user.sub],
      );
      const collection = result.rows[0];

      for (const tenantId of requestedIds) {
        await client.query(
          'INSERT INTO tenant_collection_access (tenant_id, collection_id) VALUES ($1, $2)',
          [tenantId, collection.id],
        );
      }

      await client.query('COMMIT');
      return Response.json(collection, { status: 201 });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}

// Whitelisted sort keys mapped to fixed ORDER BY clauses — orderBy is never
// built from user input, only looked up from this map (same pattern as
// SORT_MAP in /api/media). LOWER(...) keeps the sort case-insensitive without
// needing a collation change.
const COLLECTION_SORT_MAP: Record<string, string> = {
  default: 'c.created_at DESC',
  name_asc: 'LOWER(c.name) ASC',
  name_desc: 'LOWER(c.name) DESC',
};

// Whitelisted page sizes — pageSize is validated against this list, never
// taken from the request as-is. Same convention as /api/media (Stage 61) and
// /api/collections/[id]/files (Stage 63).
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

export async function GET(request: Request) {
  const user = requireAuth(request);
  if (user instanceof Response) return user;

  try {
    const { searchParams } = new URL(request.url);
    const parentIdParam = searchParams.get('parentId');

    // absent or "root" → top-level only; anything else → direct children of that id
    const topLevel = parentIdParam === null || parentIdParam === 'root';

    const sortKey = searchParams.get('sort') ?? 'default';
    const orderBy = COLLECTION_SORT_MAP[sortKey] ?? COLLECTION_SORT_MAP.default;

    // Pagination is opt-in: only triggered when `page` is present on the request.
    // Existing callers that never send it (the "Add to collection" picker, the
    // media collection-filter dropdown, the shares target picker) keep getting
    // the bare array they've always gotten — no behavior change, no extra query.
    const paginate = searchParams.has('page');
    const pageSizeRaw = Number(searchParams.get('pageSize'));
    const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE;
    const requestedPageRaw = Number(searchParams.get('page'));
    const requestedPage = Number.isInteger(requestedPageRaw) && requestedPageRaw >= 1 ? requestedPageRaw : 1;

    // Per-collection counts (direct sub-collections, files linked via collection_resource)
    // are computed as correlated subqueries on top of whichever already-filtered set of
    // collections `c` resolves to below — they never widen or bypass the access rules.
    const countColumns = `,
         (SELECT COUNT(*)::int FROM collections sc WHERE sc.parent_id = c.id) AS subcollection_count,
         (SELECT COUNT(*)::int FROM collection_resource cr WHERE cr.collection_id = c.id) AS file_count`;

    // Stage 6: full unscoped visibility is a super-admin-only bypass — a
    // tenant admin also has canAdmin: true but must fall through to the
    // same tenant-scoped cascade every editor/viewer already uses below,
    // not see every tenant's collections.
    if (isSuperAdmin(user)) {
      const whereClause = topLevel ? 'c.parent_id IS NULL' : 'c.parent_id = $1';
      const baseParams = topLevel ? [] : [parentIdParam];

      if (!paginate) {
        const result = await db.query(
          `SELECT c.*${countColumns} FROM collections c WHERE ${whereClause} ORDER BY ${orderBy}`,
          baseParams,
        );
        return Response.json(result.rows);
      }

      // total — identical FROM/WHERE as the page query, just counted, so it
      // reflects the same admin-visible set (all collections at this level).
      const countResult = await db.query(
        `SELECT COUNT(*)::int AS total FROM collections c WHERE ${whereClause}`,
        baseParams,
      );
      const total = countResult.rows[0]?.total ?? 0;

      const lastPage = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, lastPage);
      const offset = (page - 1) * pageSize;

      const rowParams = [...baseParams, pageSize, offset];
      const limitParam = `$${rowParams.length - 1}`;
      const offsetParam = `$${rowParams.length}`;

      const result = await db.query(
        `SELECT c.*${countColumns} FROM collections c WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ${limitParam} OFFSET ${offsetParam}`,
        rowParams,
      );
      return Response.json({ collections: result.rows, total, page, pageSize });
    }

    // Non-admins: a grant is valid at any depth and cascades downward (Stage 88 —
    // was root-only). Two genuinely different questions depending on whether a
    // specific parent was requested:
    //
    //   - No parentId (home page, topLevel): "what are the highest collections
    //     this tenant can reach?" — granted collections with no granted
    //     ancestor. Not `parent_id IS NULL` (those may be ungranted while a
    //     descendant is granted) and not every accessible collection (a granted
    //     child of an already-granted parent must not also surface here).
    //   - parentId present: "which direct children of this collection is the
    //     tenant allowed to see?" — each child is accessible if it, or any of
    //     its own ancestors (including the requested parent), carries a grant.
    //
    // Fail closed: no tenant (old token, or a data anomaly) means no query at
    // all — the same empty-result shape a granted-nothing tenant would get.
    // For a cross-tenant admin, effectiveTenant is the tenant they're acting as
    // (the switcher cookie, defaulting to their own) — their whole browse
    // surface behaves as that tenant's. For everyone else it's always just
    // their own token tenantId (a cookie is silently ignored).
    const effectiveTenant = actingTenantId(user, request);
    if (!effectiveTenant) {
      if (!paginate) return Response.json([]);
      return Response.json({ collections: [], total: 0, page: 1, pageSize });
    }

    let withRecursive: string;
    let cascadeFromWhere: string;
    let params: unknown[];

    if (topLevel) {
      // depth 0 = the collection itself, incrementing per step up. A collection
      // qualifies when it's directly granted (cca_self) and no ancestor at
      // depth >= 1 is also granted (ag IS NULL) — the "topmost grant" frontier.
      withRecursive = `WITH RECURSIVE root_finder AS (
           SELECT
             id          AS original_id,
             id          AS current_id,
             parent_id   AS current_parent,
             0           AS depth
           FROM collections

           UNION ALL

           SELECT
             rf.original_id,
             c.id          AS current_id,
             c.parent_id   AS current_parent,
             rf.depth + 1  AS depth
           FROM root_finder rf
           INNER JOIN collections c ON c.id = rf.current_parent
           WHERE rf.current_parent IS NOT NULL
         ),
         ancestor_granted AS (
           SELECT DISTINCT rf.original_id AS collection_id
           FROM root_finder rf
           INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.current_id
           WHERE cca.tenant_id = $1 AND rf.depth >= 1
         )`;
      cascadeFromWhere = `FROM collections c
         INNER JOIN tenant_collection_access cca_self
           ON cca_self.collection_id = c.id AND cca_self.tenant_id = $1
         LEFT JOIN ancestor_granted ag ON ag.collection_id = c.id
         WHERE ag.collection_id IS NULL`;
      params = [effectiveTenant];
    } else {
      withRecursive = `WITH RECURSIVE root_finder AS (
           SELECT
             id          AS original_id,
             id          AS current_id,
             parent_id   AS current_parent
           FROM collections

           UNION ALL

           SELECT
             rf.original_id,
             c.id          AS current_id,
             c.parent_id   AS current_parent
           FROM root_finder rf
           INNER JOIN collections c ON c.id = rf.current_parent
           WHERE rf.current_parent IS NOT NULL
         ),
         accessible AS (
           SELECT DISTINCT rf.original_id AS collection_id
           FROM root_finder rf
           INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.current_id
           WHERE cca.tenant_id = $1
         )`;
      cascadeFromWhere = `FROM collections c
         INNER JOIN accessible ac ON ac.collection_id = c.id
         WHERE c.parent_id = $2`;
      params = [effectiveTenant, parentIdParam];
    }

    if (!paginate) {
      const result = await db.query(
        `${withRecursive} SELECT c.*${countColumns} ${cascadeFromWhere} ORDER BY ${orderBy}`,
        params,
      );
      return Response.json(result.rows);
    }

    // total — identical CTE/JOIN/WHERE as the page query below (same cascade
    // access check, same parentId filter), just counted instead of selected/
    // limited. This is what keeps a non-admin's total scoped to only the
    // collections their tenant can actually see — never a global count.
    const countResult = await db.query(
      `${withRecursive} SELECT COUNT(*)::int AS total ${cascadeFromWhere}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, lastPage);
    const offset = (page - 1) * pageSize;

    const rowParams = [...params, pageSize, offset];
    const limitParam = `$${rowParams.length - 1}`;
    const offsetParam = `$${rowParams.length}`;

    const result = await db.query(
      `${withRecursive} SELECT c.*${countColumns} ${cascadeFromWhere} ORDER BY ${orderBy} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      rowParams,
    );
    return Response.json({ collections: result.rows, total, page, pageSize });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
