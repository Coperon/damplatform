import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, canAccessAllTenants, actingTenantId, type JwtPayload } from '@/lib/session';
import {
  EDITOR_PERMISSION_KEYS,
  VIEWER_PERMISSION_KEYS,
  EDITOR_DEFAULTS,
  VIEWER_DEFAULTS,
  type PermissionKey,
} from '@/lib/permissions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Stage 108 — the Permissions admin surface. Tenant admins (role 2) manage
// their own tenant's editor/viewer matrix; super admins (role 1) pick any
// tenant. Neither role's OWN permissions (admin/super-admin, roleId 1/2) are
// ever readable or writable here — the matrix only ever has two columns,
// editor and viewer, and every route below rejects roleId 1/2 outright if
// one is ever forced in a request body, not merely omitted from the UI.
//
// Tenant scope: resolveTenant() below is the single place tenantId comes
// from — the token for a regular tenant admin, the acting-tenant cookie for
// a cross-tenant admin, or the request's own ?tenantId=/body.tenantId ONLY for
// a true super admin. Never the other way around.
async function resolveTenant(
  req: NextRequest,
  user: JwtPayload,
  requestedTenantId: string | null,
): Promise<{ tenantId: string; tenantName: string } | NextResponse> {
  let tenantId: string;
  if (isSuperAdmin(user)) {
    if (!requestedTenantId || !UUID_RE.test(requestedTenantId)) {
      return NextResponse.json({ error: 'tenantId is required and must be a uuid' }, { status: 400 });
    }
    tenantId = requestedTenantId;
  } else if (canAccessAllTenants(user)) {
    const acting = actingTenantId(user, req);
    if (!acting) {
      return NextResponse.json({ error: 'Your account has no company to configure' }, { status: 403 });
    }
    tenantId = acting;
  } else {
    if (!user.tenantId) {
      return NextResponse.json({ error: 'Your account has no company to configure' }, { status: 403 });
    }
    tenantId = user.tenantId;
  }

  const lookup = await db.query<{ id: string; name: string }>('SELECT id, name FROM tenants WHERE id = $1', [
    tenantId,
  ]);
  if (lookup.rowCount === 0) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }
  return { tenantId, tenantName: lookup.rows[0].name };
}

function isValidKeyForRole(roleId: number, key: string): key is PermissionKey {
  if (roleId === 3) return (EDITOR_PERMISSION_KEYS as readonly string[]).includes(key);
  if (roleId === 4) return (VIEWER_PERMISSION_KEYS as readonly string[]).includes(key);
  return false;
}

function defaultForRole(roleId: number, key: PermissionKey): boolean {
  return roleId === 3 ? EDITOR_DEFAULTS[key as keyof typeof EDITOR_DEFAULTS] : VIEWER_DEFAULTS[key as keyof typeof VIEWER_DEFAULTS];
}

export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { searchParams } = new URL(req.url);
  const resolved = await resolveTenant(req, user, searchParams.get('tenantId'));
  if (resolved instanceof NextResponse) return resolved;
  const { tenantId, tenantName } = resolved;

  const result = await db.query<{ role_id: number; permission_key: string; enabled: boolean }>(
    'SELECT role_id, permission_key, enabled FROM tenant_role_permissions WHERE tenant_id = $1',
    [tenantId],
  );
  const overrides = new Map<string, boolean>();
  for (const row of result.rows) overrides.set(`${row.role_id}:${row.permission_key}`, row.enabled);

  const buildRows = (roleId: number, keys: readonly PermissionKey[]) =>
    keys.map((key) => {
      const def = defaultForRole(roleId, key);
      const overrideKey = `${roleId}:${key}`;
      const override = overrides.has(overrideKey) ? overrides.get(overrideKey)! : null;
      return { key, default: def, override, enabled: override ?? def };
    });

  return NextResponse.json({
    tenantId,
    tenantName,
    editor: buildRows(3, EDITOR_PERMISSION_KEYS),
    viewer: buildRows(4, VIEWER_PERMISSION_KEYS),
  });
}

export async function PUT(req: NextRequest) {
  const user = requireAdmin(req);
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

  const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId : null;
  const resolved = await resolveTenant(req, user, requestedTenantId);
  if (resolved instanceof NextResponse) return resolved;
  const { tenantId } = resolved;

  const roleId = typeof body.roleId === 'number' ? body.roleId : null;
  // The hard boundary: admin/super-admin capability is fixed, never
  // configurable — rejected here regardless of what the UI ever sends,
  // since the UI never exposes this at all.
  if (roleId !== 3 && roleId !== 4) {
    return NextResponse.json(
      { error: 'Admin and super-admin permissions are fixed and cannot be configured' },
      { status: 403 },
    );
  }

  const permissionKey = typeof body.permissionKey === 'string' ? body.permissionKey : null;
  if (!permissionKey || !isValidKeyForRole(roleId, permissionKey)) {
    return NextResponse.json({ error: 'permissionKey is not valid for this role' }, { status: 400 });
  }

  const enabled = body.enabled;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }

  await db.query(
    `INSERT INTO tenant_role_permissions (tenant_id, role_id, permission_key, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, role_id, permission_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [tenantId, roleId, permissionKey, enabled],
  );

  return NextResponse.json({
    key: permissionKey,
    default: defaultForRole(roleId, permissionKey),
    override: enabled,
    enabled,
  });
}

export async function DELETE(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { searchParams } = new URL(req.url);
  const resolved = await resolveTenant(req, user, searchParams.get('tenantId'));
  if (resolved instanceof NextResponse) return resolved;
  const { tenantId } = resolved;

  // Bulk path — "Reset all to defaults": every row this tenant has is
  // already role 3/4-only (PUT rejects 1/2 outright), so a plain
  // tenant-scoped delete can't touch admin/super-admin capability.
  if (searchParams.get('all') === 'true') {
    await db.query('DELETE FROM tenant_role_permissions WHERE tenant_id = $1', [tenantId]);
    return NextResponse.json({ tenantId, reset: true });
  }

  const roleIdRaw = Number(searchParams.get('roleId'));
  const roleId = Number.isInteger(roleIdRaw) ? roleIdRaw : null;
  if (roleId !== 3 && roleId !== 4) {
    return NextResponse.json(
      { error: 'Admin and super-admin permissions are fixed and cannot be configured' },
      { status: 403 },
    );
  }

  const permissionKey = searchParams.get('permissionKey');
  if (!permissionKey || !isValidKeyForRole(roleId, permissionKey)) {
    return NextResponse.json({ error: 'permissionKey is not valid for this role' }, { status: 400 });
  }

  await db.query(
    'DELETE FROM tenant_role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_key = $3',
    [tenantId, roleId, permissionKey],
  );

  const def = defaultForRole(roleId, permissionKey);
  return NextResponse.json({ key: permissionKey, default: def, override: null, enabled: def });
}
