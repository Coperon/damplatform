import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAuth, canAccessAllTenants } from '@/lib/session';
import { logAccess } from '@/lib/accessLog';

// Dedicated endpoint for the "view" signal widened to lightbox opens — the
// truer "looked at this one asset" moment than a card/thumbnail render, and a
// second, independent source of 'view' events alongside the pre-existing
// GET /api/resources/[id]/metadata signal (opening the Details drawer or the
// full metadata editor). Both are kept: they're two structurally distinct UI
// actions (a thumbnail click vs. a "Details" button), never triggered by the
// same click, so logging both is two real looks, not one look counted twice.
// Metadata records { source: 'lightbox' } so the two signals stay
// distinguishable in the log even though both write action: 'view'.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  const resourceCheck = await db.query('SELECT id FROM resources WHERE id = $1', [id]);
  if (resourceCheck.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Identical cascade access check to GET /api/resources/[id]/metadata and
  // GET /api/download/[id] — a lightbox open is only ever logged for a
  // resource this user's tenant can actually reach.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
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
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  // Fire-and-forget, only reached past the access check above — a denied
  // lightbox open is never logged as activity.
  logAccess({
    userId: user.sub,
    tenantId: user.tenantId ?? null,
    resourceId: id,
    action: 'view',
    metadata: { source: 'lightbox' },
  });

  return NextResponse.json({ ok: true });
}
