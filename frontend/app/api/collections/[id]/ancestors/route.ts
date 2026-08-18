import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAuth, canAccessAllTenants } from '@/lib/session';

// Same cascade ancestor access check used by GET /api/collections/[id] and the
// files/download routes: walk up from `collectionId` and check whether the
// user's tenant has a grant anywhere in that chain — at any level, not just
// the root (Stage 88: was root-only). Reused verbatim (parameterized per id)
// rather than re-derived, so ancestor accessibility never drifts from the real
// rule. Called once per ancestor below, each with its own starting id, so a
// grant partway up the chain (e.g. on "Lamps") correctly makes only Lamps and
// its own descendants accessible — not the collections above Lamps.
// `tenantId === null` (no tenant) short-circuits to false — never passed through
// to a query, since `tenant_id = NULL` isn't a valid grant to check.
async function isAccessible(collectionId: string, tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;
  const result = await db.query(
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
    [collectionId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  const lookup = await db.query('SELECT id FROM collections WHERE id = $1', [id]);
  if (lookup.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // cross-tenant users (super admin, or role-2 + can_access_all_tenants) bypass this —
  // everyone else must pass the same tenant-scoped check.
  if (!canAccessAllTenants(user)) {
    const accessible = await isAccessible(id, user.tenantId ?? null);
    if (!accessible) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  // Walk UP the tree from this collection (inclusive), then drop the collection
  // itself, root first.
  const chain = await db.query<{ id: string; name: string; depth: number }>(
    `WITH RECURSIVE ancestor_chain AS (
       SELECT id, name, parent_id, 0 AS depth FROM collections WHERE id = $1
       UNION ALL
       SELECT c.id, c.name, c.parent_id, ac.depth + 1
       FROM collections c
       INNER JOIN ancestor_chain ac ON ac.parent_id = c.id
     )
     SELECT id, name, depth FROM ancestor_chain WHERE id != $1 ORDER BY depth DESC`,
    [id],
  );

  if (canAccessAllTenants(user)) {
    return NextResponse.json(
      chain.rows.map((row) => ({ id: row.id, name: row.name, accessible: true })),
    );
  }

  const ancestors = await Promise.all(
    chain.rows.map(async (row) => {
      const accessible = await isAccessible(row.id, user.tenantId ?? null);
      return { id: row.id, name: accessible ? row.name : null, accessible };
    }),
  );

  return NextResponse.json(ancestors);
}
