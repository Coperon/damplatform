import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, actingTenantId } from '@/lib/session';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const roleIdParam = req.nextUrl.searchParams.get('roleId');
  let roleId: number | null = null;

  if (roleIdParam !== null) {
    roleId = Number(roleIdParam);
    if (!Number.isInteger(roleId)) {
      return NextResponse.json({ error: 'roleId must be an integer' }, { status: 400 });
    }

    const roleCheck = await db.query('SELECT id FROM roles WHERE id = $1', [roleId]);
    if (roleCheck.rows.length === 0) {
      return NextResponse.json({ error: `Role ${roleId} does not exist` }, { status: 400 });
    }
  }

  // Tenant-scoped enforcement: a super admin sees every user; everyone else
  // sees one tenant's users — for a cross-tenant admin that's the tenant
  // they're acting as (the switcher cookie, defaulting to their own), for a
  // regular tenant admin it's always their own token tenantId (a cookie is
  // silently ignored). Never a request param.
  // Fail closed: no resolvable tenant gets an empty list rather than
  // falling back to "see everyone."
  const superAdmin = isSuperAdmin(user);
  const effectiveTenant = actingTenantId(user, req);
  if (!superAdmin && !effectiveTenant) {
    return NextResponse.json([]);
  }

  // tenantId — narrows the result to one tenant. Super-admin-only: a
  // tenant admin's view is already pinned to their own token tenantId
  // below, so any tenantId they send is silently ignored (not validated,
  // not applied) rather than erroring — same discipline as POST
  // /api/invitations forcing tenantId from the token instead of the body.
  const tenantIdParam = req.nextUrl.searchParams.get('tenantId');
  if (superAdmin && tenantIdParam !== null) {
    if (!UUID_RE.test(tenantIdParam)) {
      return NextResponse.json({ error: 'tenantId must be a valid uuid' }, { status: 400 });
    }
    const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1', [tenantIdParam]);
    if (tenantCheck.rows.length === 0) {
      return NextResponse.json({ error: 'tenantId does not exist' }, { status: 400 });
    }
  }

  const whereClauses: string[] = [];
  const params: unknown[] = [];
  if (roleId !== null) {
    params.push(roleId);
    whereClauses.push(`u.role_id = $${params.length}`);
  }
  if (!superAdmin) {
    params.push(effectiveTenant);
    whereClauses.push(`u.tenant_id = $${params.length}`);
  } else if (tenantIdParam !== null) {
    params.push(tenantIdParam);
    whereClauses.push(`u.tenant_id = $${params.length}`);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const result = await db.query<{
    id: string;
    email: string;
    name: string | null;
    tenant_id: string | null;
    tenant_name: string | null;
    role_id: number;
    role_name: string;
    can_access_all_tenants: boolean;
    can_invite: boolean;
    created_at: string;
  }>(
    `SELECT u.id, u.email, u.name,
            u.tenant_id, co.name AS tenant_name, u.role_id, r.name AS role_name, u.can_access_all_tenants, u.can_invite,
            u.created_at
     FROM users u
     LEFT JOIN tenants co ON co.id = u.tenant_id
     LEFT JOIN roles r ON r.id = u.role_id
     ${whereSql}
     ORDER BY u.created_at DESC, u.email`,
    params,
  );

  return NextResponse.json(result.rows);
}
