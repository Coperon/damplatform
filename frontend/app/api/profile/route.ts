import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAuth } from '@/lib/session';
import { getPendingEmailChange } from '@/lib/emailChange';

const MAX_NAME_LENGTH = 100;

// A user's own profile — every authenticated role reads/writes their own
// row here. Deliberately NOT PATCH /api/users/[id] (admin-only, blocks
// self-edit): this route is self-edit-only, the opposite restriction.
export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  const result = await db.query<{
    id: string;
    email: string;
    name: string | null;
    phone: string | null;
    tenant_id: string | null;
    role_id: number;
    role_name: string;
  }>(
    `SELECT u.id, u.email, u.name, u.phone, u.tenant_id, u.role_id, r.name AS role_name
     FROM users u LEFT JOIN roles r ON u.role_id = r.id
     WHERE u.id = $1`,
    [user.sub],
  );
  const row = result.rows[0];
  if (!row) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Company details — a company admin's own company only (role_id === 2).
  // True super admins (role_id === 1) have no tenant at all and never see
  // this section; editors/viewers (3/4) don't get it either. Cross-tenant
  // access doesn't widen this, and the acting-company switcher never
  // applies here — see app/api/profile/tenant/route.ts and the Profile
  // page's own caption for why.
  let tenant: { id: string; name: string; address: string | null; phone: string | null } | null = null;
  if (row.role_id === 2 && row.tenant_id) {
    const tenantResult = await db.query<{
      id: string;
      name: string;
      address: string | null;
      phone: string | null;
    }>('SELECT id, name, address, phone FROM tenants WHERE id = $1', [row.tenant_id]);
    tenant = tenantResult.rows[0] ?? null;
  }

  const pendingEmailChange = await getPendingEmailChange(row.id);

  return NextResponse.json({
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    tenantId: row.tenant_id,
    roleId: row.role_id,
    roleName: row.role_name,
    tenant,
    pendingEmailChange,
  });
}

// Name only — password goes through the existing
// POST /api/auth/change-password, email through
// POST/DELETE /api/profile/email-change (verification-gated), and company
// details through PATCH /api/profile/tenant. Kept this narrow so a stray
// extra key in the body can never be misread as an update to something
// else.
export async function PATCH(req: NextRequest) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || !('name' in body)) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const name = (body as { name: unknown }).name;
  if (typeof name !== 'string') {
    return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
  }
  // Required, not nullable-on-blank like the admin edit route — Stage 66
  // made name required at signup precisely because a blank name defeats the
  // point of showing it everywhere; self-edit shouldn't reopen that gap.
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  if (!trimmed) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  const result = await db.query<{ id: string; name: string | null }>(
    'UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name',
    [trimmed, user.sub],
  );
  return NextResponse.json(result.rows[0]);
}
