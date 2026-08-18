import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  email: string;
  name?: string | null;
  canDownload: boolean;
  canUpload: boolean;
  canAdmin: boolean;
  tenantId?: string | null;
  roleId?: number;
  roleName?: string;
  // Minted from users.can_access_all_tenants at login (true unconditionally for role 1).
  // Never read from a request value — only ever from the verified token.
  canAccessAllTenants?: boolean;
  // Minted from users.can_invite at login (true unconditionally for role 1).
  // Never read from a request value — only ever from the verified token.
  canInvite?: boolean;
  iat: number;
  exp: number;
}

function verifyToken(request: Request): JwtPayload | Response {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return Response.json({ message: 'No token provided' }, { status: 401 });
  }
  const token = auth.slice(7);
  try {
    return jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as JwtPayload;
  } catch {
    return Response.json({ message: 'Invalid or expired token' }, { status: 401 });
  }
}

export function requireAuth(request: Request): JwtPayload | Response {
  return verifyToken(request);
}

// Super admin = role 1 only (tenant_id: null, unrestricted). Derived from the
// token's own roleId, never from canAdmin — canAdmin is also true for a
// tenant admin (role 2) as of Stage 6, so any check that needs to
// distinguish "true super admin" from "tenant admin" must use this, not
// `user.canAdmin`. Fails closed on a token minted before roleId existed
// (Stage 85) or any other missing/non-1 value.
export function isSuperAdmin(payload: Pick<JwtPayload, 'roleId'>): boolean {
  return payload.roleId === 1;
}

// Cross-tenant access = full admin access across every tenant (but NOT the
// authority to invite, create tenants, set can_access_all_tenants, or edit
// global metadata field definitions — those stay super-admin-only). Role 1
// has it BY DEFINITION — hardcoded here, never dependent on the
// users.can_access_all_tenants column or the minted claim; everyone else
// has it only when their verified token carries canAccessAllTenants: true
// (minted from the DB column at login, never from any request value). Fails
// closed on old-shape tokens.
export function canAccessAllTenants(payload: Pick<JwtPayload, 'roleId' | 'canAccessAllTenants'>): boolean {
  return payload.roleId === 1 || payload.canAccessAllTenants === true;
}

// Invite authority — per-user grant, same shape as canAccessAllTenants above: role 1
// can always invite (hardcoded, never dependent on the users.can_invite
// column); everyone else only when their verified token carries
// canInvite: true (minted from the DB column at login, never from any
// request value). Supersedes the old blanket "cross-tenant admins can never
// invite" rule — a cross-tenant admin (role 2 + can_access_all_tenants) with this flag set
// may now invite, but only into their own tenant; POST /api/invitations
// enforces that separately, this helper only answers "may this caller
// invite at all." Fails closed on a token minted before this claim existed.
export function canInvite(payload: Pick<JwtPayload, 'roleId' | 'canInvite'>): boolean {
  return payload.roleId === 1 || payload.canInvite === true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The tenant a cross-tenant user is currently "acting as" — the tenant switcher
// (components/AppShell.tsx) stores the selection in the dam_acting_tenant
// cookie, which the browser sends on every request with no per-call-site
// wiring. Honored ONLY for a cross-tenant caller; for everyone else a cookie
// value is silently ignored (never an error — same discipline as
// POST /api/invitations ignoring a tenant admin's tenantId), so the result is
// always their own token tenantId. Cross-tenant callers with no/invalid cookie
// default to their own tenant too. A nonexistent-but-well-formed uuid simply
// matches nothing downstream (every cascade fails closed on it).
export function actingTenantId(payload: JwtPayload, request: Request): string | null {
  if (canAccessAllTenants(payload)) {
    const cookieHeader = request.headers.get('cookie');
    if (cookieHeader) {
      for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === 'dam_acting_tenant') {
          const value = decodeURIComponent(part.slice(eq + 1).trim());
          if (UUID_RE.test(value)) return value;
        }
      }
    }
  }
  return payload.tenantId ?? null;
}

// Structure/cross-tenant routes (collection create/delete/rename, the Access
// modal, metadata-field definitions, the admin media library, shares,
// tenant-scoped-user-management's own tenant list, etc.) — role 1 only.
export function requireSuperAdmin(request: Request): JwtPayload | Response {
  const result = verifyToken(request);
  if (result instanceof Response) return result;
  if (!isSuperAdmin(result)) {
    return Response.json({ message: 'Super admin access required' }, { status: 403 });
  }
  return result;
}

// "Admin" in the broad sense — super_admin or (as of Stage 6) tenant admin,
// role 1 or 2, both of which carry canAdmin: true. Tenant-scoped routes
// (GET /api/users, PATCH /api/users/[id]) use this plus their own explicit
// same-tenant enforcement; every other admin route now uses requireSuperAdmin
// instead, per the Stage 6 classification.
export function requireAdmin(request: Request): JwtPayload | Response {
  const result = verifyToken(request);
  if (result instanceof Response) return result;
  if (!result.canAdmin) {
    return Response.json({ message: 'Admin access required' }, { status: 403 });
  }
  return result;
}

export function requireUpload(request: Request): JwtPayload | Response {
  const result = verifyToken(request);
  if (result instanceof Response) return result;
  if (!result.canUpload) {
    return Response.json({ message: 'Upload permission required' }, { status: 403 });
  }
  return result;
}

export function requireDownload(request: Request): JwtPayload | Response {
  const result = verifyToken(request);
  if (result instanceof Response) return result;
  if (!result.canDownload) {
    return Response.json({ message: 'Download permission required' }, { status: 403 });
  }
  return result;
}
