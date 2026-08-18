import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, canAccessAllTenants } from '@/lib/session';
import { tenantHasCollectionAccess } from '@/lib/permissions';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  // Tenant-scoped enforcement: feeds the delete-warning UI, so it must be
  // gated the same as the delete it precedes — a tenant admin may only see
  // the descendant count of a collection their tenant can reach.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId || !(await tenantHasCollectionAccess(user.tenantId, id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  // Walk DOWN the tree from this collection and count all descendants (not itself).
  const result = await db.query<{ count: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM collections WHERE parent_id = $1
       UNION ALL
       SELECT c.id FROM collections c
       JOIN descendants d ON c.parent_id = d.id
     )
     SELECT COUNT(*) AS count FROM descendants`,
    [id],
  );

  return NextResponse.json({ count: Number(result.rows[0].count) });
}
