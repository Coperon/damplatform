import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { validateInvitationToken } from '@/lib/invitations';

// Public, no auth — feeds the redemption page. Never returns the token,
// tenantId, or roleId itself; only what the redemption form needs to render
// (locked email, tenant/role labels).
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const validation = await validateInvitationToken(token);

  if (validation.status !== 'valid') {
    // Same generic shape for every failure mode (not-found, bad token,
    // expired, already-accepted) — no oracle distinguishing any of them.
    return NextResponse.json(
      { status: 'invalid', message: 'This invitation link is invalid or has expired.' },
      { status: 400 },
    );
  }

  const { invitation } = validation;

  const tenantLookup = await db.query<{ name: string }>(
    'SELECT name FROM tenants WHERE id = $1',
    [invitation.tenantId],
  );
  const tenant = tenantLookup.rows[0];
  if (!tenant) {
    // The tenant was deleted out from under a still-unexpired invite —
    // treat exactly like any other invalid token, fail closed.
    return NextResponse.json(
      { status: 'invalid', message: 'This invitation link is invalid or has expired.' },
      { status: 400 },
    );
  }

  const roleLookup = await db.query<{ name: string }>('SELECT name FROM roles WHERE id = $1', [invitation.roleId]);
  const roleName = roleLookup.rows[0]?.name ?? null;

  return NextResponse.json({
    status: 'valid',
    email: invitation.email,
    tenantName: tenant.name,
    roleName,
  });
}
