import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, actingTenantId } from '@/lib/session';
import { AppError } from '@/lib/errors';

const MAX_Q_LEN = 100;
// Whitelisted page sizes — pageSize is validated against this list, never
// taken from the request as-is.
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelisted sort keys mapped to fixed ORDER BY clauses.
// orderBy is never built from user input — only from this map.
const SORT_MAP: Record<string, string> = {
  newest: 'r.created_at DESC',
  oldest: 'r.created_at ASC',
  largest: 'r.size_bytes DESC',
  smallest: 'r.size_bytes ASC',
  // LOWER(...) rather than a case-insensitive collation — no COLLATE is set up
  // elsewhere in the schema, and this needs no new dependency or migration.
  name_asc: 'LOWER(r.original_filename) ASC',
  name_desc: 'LOWER(r.original_filename) DESC',
};

export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const superAdmin = isSuperAdmin(user);

  try {
    const { searchParams } = new URL(req.url);

    // sort — whitelist lookup; unrecognised values fall back to newest
    const sortKey = searchParams.get('sort') ?? 'newest';
    const orderBy = SORT_MAP[sortKey] ?? SORT_MAP.newest;

    // Accumulate parameterised values; WHERE conditions reference $n placeholders.
    const params: unknown[] = [];
    const where: string[] = [];

    // Tenant-scoped enforcement: a tenant admin sees only resources that
    // sit in at least one collection their tenant can reach, at any depth —
    // the same cascade `lib/permissions.ts::tenantHasResourceAccess` runs
    // for a single resource, reused here inline as a correlated EXISTS (its
    // own CTE alias `root_finder`, its own join alias `cr3` — never `cr`/`c`
    // below) so it composes with every other filter in one query instead of
    // N+1 per-row lookups. A true super admin bypasses
    // this and sees every resource, including unassigned ones, unchanged.
    // Deliberately NOT a condition on the existing `cr` alias below — that
    // LEFT JOIN is load-bearing for the unassigned-only HAVING further down,
    // and constraining it directly would turn it into an inner join and
    // silently break that filter (same reasoning as the collectionId filter
    // right below). Fail closed: no tenant (old token, or a data anomaly)
    // sees nothing rather than falling back to "see everything."
    if (!superAdmin) {
      // cross-tenant admins are scoped to the tenant they're acting as (the
      // switcher cookie, defaulting to their own tenant) — their media
      // library reads as that tenant's view; a regular tenant admin's
      // actingTenantId is always just their own tenant (cookie ignored).
      const effectiveTenant = actingTenantId(user, req);
      if (!effectiveTenant) {
        return NextResponse.json({ files: [], total: 0, page: 1, pageSize: DEFAULT_PAGE_SIZE });
      }
      params.push(effectiveTenant);
      const n = params.length;
      where.push(
        `EXISTS (
           WITH RECURSIVE root_finder AS (
             SELECT col.id, col.parent_id
             FROM collections col
             INNER JOIN collection_resource cr3 ON cr3.collection_id = col.id
             WHERE cr3.resource_id = r.id
             UNION ALL
             SELECT col.id, col.parent_id
             FROM collections col
             INNER JOIN root_finder rf ON rf.parent_id = col.id
             WHERE rf.parent_id IS NOT NULL
           )
           SELECT 1 FROM root_finder rf
           INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.id
           WHERE cca.tenant_id = $${n}
           LIMIT 1
         )`,
      );
    }

    // type filter — the MIME prefix strings are hardcoded here, never from user input
    const type = searchParams.get('type');
    if (type === 'image') {
      where.push(`r.mime_type LIKE 'image/%'`);
    } else if (type === 'video') {
      where.push(`r.mime_type LIKE 'video/%'`);
    } else if (type === 'audio') {
      where.push(`r.mime_type LIKE 'audio/%'`);
    } else if (type === 'other') {
      where.push(
        `r.mime_type NOT LIKE 'image/%' AND r.mime_type NOT LIKE 'video/%' AND r.mime_type NOT LIKE 'audio/%'`,
      );
    }
    // Unrecognised type values are silently ignored (no filter applied).

    // q — name / description ILIKE search
    const rawQ = searchParams.get('q');
    if (rawQ && rawQ.trim()) {
      const term = rawQ.trim().slice(0, MAX_Q_LEN);
      params.push(term);
      const n = params.length;
      where.push(
        `(r.original_filename ILIKE '%' || $${n} || '%' OR r.description ILIKE '%' || $${n} || '%')`,
      );
    }

    // collectionId — restricts to a collection or any of its descendants via a
    // recursive CTE + EXISTS, deliberately not a condition on the existing `cr`
    // alias: that LEFT JOIN is load-bearing for the unassigned-only HAVING below,
    // and constraining it directly would turn it into an inner join and silently
    // break that filter.
    const collectionIdRaw = searchParams.get('collectionId');
    let subtreeCte = '';
    if (collectionIdRaw) {
      if (!UUID_RE.test(collectionIdRaw)) {
        return NextResponse.json({ message: 'collectionId must be a valid uuid' }, { status: 400 });
      }
      params.push(collectionIdRaw);
      const n = params.length;
      // Seed with the requested collection itself, then walk parent_id downward.
      // A collectionId that doesn't exist yields an empty subtree — EXISTS is
      // then vacuously false for every resource, so this naturally returns an
      // empty page + total: 0 with no separate existence check needed.
      subtreeCte = `WITH RECURSIVE subtree AS (
         SELECT id FROM collections WHERE id = $${n}
         UNION ALL
         SELECT child.id FROM collections child INNER JOIN subtree s ON child.parent_id = s.id
       ) `;
      where.push(
        `EXISTS (SELECT 1 FROM collection_resource cr2 WHERE cr2.resource_id = r.id AND cr2.collection_id IN (SELECT id FROM subtree))`,
      );
    }

    // unassigned — enforced in HAVING after GROUP BY, not in WHERE. Combined
    // with collectionId above, EXISTS (>=1 link in the subtree) and HAVING
    // COUNT(cr.resource_id) = 0 (zero links total) can never both hold for the
    // same resource, so this combination naturally yields zero rows — not an error.
    const unassignedOnly = searchParams.get('unassigned') === 'true';

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const havingClause = unassignedOnly ? 'HAVING COUNT(cr.resource_id) = 0' : '';

    // pageSize — whitelist lookup; unrecognised values fall back to the default
    const pageSizeRaw = Number(searchParams.get('pageSize'));
    const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE;

    const requestedPageRaw = Number(searchParams.get('page'));
    const requestedPage = Number.isInteger(requestedPageRaw) && requestedPageRaw >= 1 ? requestedPageRaw : 1;

    // total — identical FROM/JOIN/WHERE/GROUP BY/HAVING as the page query below,
    // just counted instead of selected/limited, so it reflects the same filtered
    // set (type, unassigned-only, q) rather than the whole table.
    const countResult = await db.query(
      `${subtreeCte}SELECT COUNT(*)::int AS total FROM (
         SELECT r.id
         FROM resources r
         LEFT JOIN collection_resource cr ON cr.resource_id = r.id
         LEFT JOIN collections c ON c.id = cr.collection_id
         ${whereClause}
         GROUP BY r.id
         ${havingClause}
       ) counted`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Clamp: a page past the end returns the last page's rows instead of an
    // empty result (chosen over "return empty + let the client clamp" — this
    // way a stale page number from a shrinking result set never shows a blank
    // grid with a nonzero total).
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, lastPage);
    const offset = (page - 1) * pageSize;

    const rowParams = [...params, pageSize, offset];
    const limitParam = `$${rowParams.length - 1}`;
    const offsetParam = `$${rowParams.length}`;

    const result = await db.query(
      `${subtreeCte}SELECT
         r.id,
         r.original_filename,
         r.mime_type,
         r.size_bytes,
         r.description,
         r.created_at,
         r.thumbnail_storage_key,
         COALESCE(
           json_agg(json_build_object('id', c.id, 'name', c.name))
           FILTER (WHERE c.id IS NOT NULL),
           '[]'::json
         ) AS collections
       FROM resources r
       LEFT JOIN collection_resource cr ON cr.resource_id = r.id
       LEFT JOIN collections c ON c.id = cr.collection_id
       ${whereClause}
       GROUP BY r.id
       ${havingClause}
       ORDER BY ${orderBy}
       LIMIT ${limitParam}
       OFFSET ${offsetParam}`,
      rowParams,
    );

    return NextResponse.json({ files: result.rows, total, page, pageSize });
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    console.error('/api/media error:', err);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
