import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAuth, canAccessAllTenants } from '@/lib/session';
import { tenantHasCollectionAccess } from '@/lib/permissions';

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
    const accessible = user.tenantId
      ? await tenantHasCollectionAccess(user.tenantId, id)
      : false;
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
      const accessible = user.tenantId
        ? await tenantHasCollectionAccess(user.tenantId, row.id)
        : false;
      return { id: row.id, name: accessible ? row.name : null, accessible };
    }),
  );

  return NextResponse.json(ancestors);
}
