import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireSuperAdmin, requireAdmin, isSuperAdmin, canAccessAllTenants } from '@/lib/session';

const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 255;
const MAX_PHONE_LENGTH = 30;

// The super admin enters ALL tenant details here, at creation — address and
// phone are required, not optional, so a newly-created tenant is always
// complete and invite redemption never has to collect tenant info (the old
// "name-only stub filled in by the first admin" flow is gone). Pre-existing
// tenants may still carry NULL address/phone; a tenant admin fills those in
// via the profile page, not here.
export async function POST(req: NextRequest) {
  const user = requireSuperAdmin(req);
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'Company name is required' }, { status: 400 });
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `Company name must be ${MAX_NAME_LENGTH} characters or fewer` },
      { status: 400 },
    );
  }

  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!address) {
    return NextResponse.json({ error: 'Company address is required' }, { status: 400 });
  }
  if (address.length > MAX_ADDRESS_LENGTH) {
    return NextResponse.json(
      { error: `Company address must be ${MAX_ADDRESS_LENGTH} characters or fewer` },
      { status: 400 },
    );
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!phone) {
    return NextResponse.json({ error: 'Company phone is required' }, { status: 400 });
  }
  if (phone.length > MAX_PHONE_LENGTH) {
    return NextResponse.json(
      { error: `Company phone must be ${MAX_PHONE_LENGTH} characters or fewer` },
      { status: 400 },
    );
  }

  // tenants.name has no DB-level unique constraint — checked here instead,
  // case-insensitively, so "Acme" and "acme" don't produce two rows that
  // would be indistinguishable in every tenant picker in the app. 409, not
  // a silent dedupe, since the caller may have meant a genuinely different
  // tenant that happens to share a name and should pick a more specific one.
  const existing = await db.query('SELECT id FROM tenants WHERE LOWER(name) = LOWER($1)', [name]);
  if ((existing.rowCount ?? 0) > 0) {
    return NextResponse.json({ error: 'A company with this name already exists' }, { status: 409 });
  }

  const insert = await db.query<{ id: string; name: string }>(
    'INSERT INTO tenants (name, address, phone) VALUES ($1, $2, $3) RETURNING id, name',
    [name, address, phone],
  );
  const tenant = insert.rows[0];

  return NextResponse.json(
    { id: tenant.id, name: tenant.name, userCount: 0, hasAdmin: false },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  // Bare list (id/name only): super admins AND cross-tenant admins — the latter
  // need it to populate the AppShell tenant switcher. ?detail=true (user
  // counts, admin presence) and POST stay strictly super-admin-only; a
  // tenant admin without cross-tenant access still gets 403 on every shape, as before.
  const user = requireAdmin(req);
  if (user instanceof Response) return user;
  if (!canAccessAllTenants(user)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);

  // Opt-in — absent, this returns the exact bare array it always has
  // (app/admin/users/page.tsx's Company picker and app/home/page.tsx's
  // "New collection" grant checkboxes both call it this way and must keep
  // working unchanged). ?detail=true is the new shape, for the tenant
  // management page only.
  if (searchParams.get('detail') !== 'true') {
    const result = await db.query<{ id: string; name: string }>(
      'SELECT id, name FROM tenants ORDER BY name',
    );
    return NextResponse.json(result.rows);
  }

  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: 'Super admin access required' }, { status: 403 });
  }

  const result = await db.query<{
    id: string;
    name: string;
    user_count: number;
    has_admin: boolean;
  }>(
    `SELECT
       c.id, c.name,
       (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = c.id) AS user_count,
       EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = c.id AND u.role_id = 2) AS has_admin
     FROM tenants c
     ORDER BY c.name`,
  );

  const tenants = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    userCount: row.user_count,
    hasAdmin: row.has_admin,
  }));

  return NextResponse.json({ tenants });
}
