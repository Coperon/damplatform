import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin } from '@/lib/session';

// Revoke (cancel) a pending invite. Scoped to the caller's own tenant for a
// tenant admin — a super admin may cancel any. Deliberately only ever
// touches an unaccepted row: once redeemed, the invite is history, not a
// pending thing to cancel.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const superAdmin = isSuperAdmin(user);

  if (!superAdmin && !user.tenantId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const result = superAdmin
    ? await db.query(
        'DELETE FROM invitations WHERE id = $1 AND accepted_at IS NULL RETURNING id',
        [id],
      )
    : await db.query(
        'DELETE FROM invitations WHERE id = $1 AND accepted_at IS NULL AND tenant_id = $2 RETURNING id',
        [id, user.tenantId],
      );

  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
