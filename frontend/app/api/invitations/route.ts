import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, canInvite } from '@/lib/session';
import { sendInvitationEmail } from '@/lib/mail';
import { INVITABLE_ROLES, TENANT_ADMIN_INVITABLE_ROLES } from '@/lib/invitations';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Invitation links are valid for 7 days — long enough to reach someone who
// doesn't check email daily, short enough that a stale, unredeemed invite
// doesn't stay a standing credential-equivalent indefinitely.
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  // Invite authority is now a per-user grant (users.can_invite), mirroring
  // can_access_all_tenants: a super admin can always invite (hardcoded); any other
  // admin — tenant or cross-tenant — needs the flag set by a super admin via
  // PATCH /api/users/[id]. This supersedes the old blanket rule that no
  // cross-tenant admin could ever invite; a cross-tenant admin with the flag may
  // now invite, but only into their own tenant — enforced below by the
  // tenant-scoping block, which uses this caller's own token tenantId and
  // never the acting-tenant switcher cookie, so a cross-tenant admin can't use
  // it to invite into a tenant they're merely "acting as."
  if (!canInvite(user)) {
    return NextResponse.json(
      { error: 'You are not allowed to send invitations' },
      { status: 403 },
    );
  }

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

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }

  const roleId = typeof body.roleId === 'number' && Number.isInteger(body.roleId) ? body.roleId : null;
  if (roleId === null || !INVITABLE_ROLES.has(roleId)) {
    return NextResponse.json(
      { error: 'roleId must be one of: 2 (admin), 3 (editor), 4 (viewer)' },
      { status: 400 },
    );
  }

  const superAdmin = isSuperAdmin(user);

  // Authorization by tier — see lib/invitations.ts's INVITABLE_ROLES/
  // TENANT_ADMIN_INVITABLE_ROLES for the constants this mirrors from
  // PATCH /api/users/[id].
  if (roleId === 2 && !superAdmin) {
    return NextResponse.json({ error: 'Only a super admin can invite an admin' }, { status: 403 });
  }
  if (!superAdmin && !TENANT_ADMIN_INVITABLE_ROLES.has(roleId)) {
    return NextResponse.json({ error: 'You are not allowed to invite this role' }, { status: 403 });
  }

  // Tenant scoping: a non-super-admin's invites are always scoped to their
  // own tenant, taken from the token — a request that sends no tenantId
  // (every real caller today — neither the tenant-admin invite form on
  // /admin/users nor a cross-tenant admin's use of it ever sends one) is
  // silently defaulted to it, unchanged from before. What's new here: a
  // cross-tenant admin now reaches this branch too (Stage 109 removed the old
  // blanket cross-tenant-admin block above), and cross-tenant admins are otherwise
  // used to acting across tenants via the acting-tenant switcher — silently
  // downgrading an explicit foreign tenantId to "your own tenant instead"
  // would risk an invite landing somewhere the caller didn't intend and
  // didn't get told about. So a tenantId that's present AND doesn't match
  // the caller's own token tenantId now fails loud (403) instead of being
  // quietly ignored; cross-tenant invites stay super-admin-only either way.
  let tenantId: string;
  if (superAdmin) {
    const requested = typeof body.tenantId === 'string' ? body.tenantId : null;
    if (!requested || !UUID_RE.test(requested)) {
      return NextResponse.json({ error: 'tenantId is required and must be a uuid' }, { status: 400 });
    }
    tenantId = requested;
  } else {
    if (!user.tenantId) {
      return NextResponse.json({ error: 'Your account has no company to invite into' }, { status: 403 });
    }
    const requested = typeof body.tenantId === 'string' ? body.tenantId : null;
    if (requested !== null && requested !== user.tenantId) {
      return NextResponse.json(
        { error: 'You may only invite into your own company' },
        { status: 403 },
      );
    }
    tenantId = user.tenantId;
  }

  const tenantLookup = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM tenants WHERE id = $1',
    [tenantId],
  );
  if (tenantLookup.rowCount === 0) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }
  const tenant = tenantLookup.rows[0];

  const roleLookup = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM roles WHERE id = $1',
    [roleId],
  );
  const role = roleLookup.rows[0];

  const existingUser = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if ((existingUser.rowCount ?? 0) > 0) {
    return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
  }

  const activeInvite = await db.query(
    `SELECT id FROM invitations
     WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [email],
  );
  if ((activeInvite.rowCount ?? 0) > 0) {
    return NextResponse.json(
      { error: 'An active invitation already exists for this email' },
      { status: 409 },
    );
  }

  // Raw token is emailed exactly once and never returned in this response or
  // stored — only its bcrypt hash is persisted, mirroring lib/shares.ts's
  // token_hash (id.token lookup shape: fetch the one row by id, then
  // bcrypt.compare, never a direct hash-equality SELECT).
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(rawToken, 10);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);

  const insert = await db.query(
    `INSERT INTO invitations (token_hash, email, tenant_id, role_id, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, tenant_id, role_id, expires_at, created_at`,
    [tokenHash, email, tenantId, roleId, user.sub, expiresAt],
  );
  const invitation = insert.rows[0];

  const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const inviteLink = `${baseUrl}/invite/${invitation.id}.${rawToken}`;

  await sendInvitationEmail(email, inviteLink, role.name, tenant.name);

  return NextResponse.json(
    {
      id: invitation.id,
      email: invitation.email,
      role: { id: roleId, name: role.name },
      tenant: { id: tenant.id, name: tenant.name },
      expiresAt: invitation.expires_at,
    },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const superAdmin = isSuperAdmin(user);
  if (!superAdmin && !user.tenantId) {
    return NextResponse.json({ invitations: [] });
  }

  // Only unaccepted invites are listed — an accepted invite is no longer a
  // "pending invite," the user it minted is what /api/users now shows.
  const whereClause = superAdmin
    ? 'i.accepted_at IS NULL'
    : 'i.accepted_at IS NULL AND i.tenant_id = $1';
  const params = superAdmin ? [] : [user.tenantId];

  const result = await db.query(
    `SELECT
       i.id, i.email, i.expires_at, i.created_at,
       i.role_id, r.name AS role_name,
       i.tenant_id, c.name AS tenant_name,
       i.invited_by, u.email AS invited_by_email, u.name AS invited_by_name
     FROM invitations i
     INNER JOIN roles r ON r.id = i.role_id
     INNER JOIN tenants c ON c.id = i.tenant_id
     LEFT JOIN users u ON u.id = i.invited_by
     WHERE ${whereClause}
     ORDER BY i.created_at DESC`,
    params,
  );

  const now = Date.now();
  const invitations = result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: { id: row.role_id, name: row.role_name },
    tenant: { id: row.tenant_id, name: row.tenant_name },
    invitedBy: row.invited_by ? { id: row.invited_by, email: row.invited_by_email, name: row.invited_by_name } : null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    status: new Date(row.expires_at).getTime() > now ? 'pending' as const : 'expired' as const,
  }));

  return NextResponse.json({ invitations });
}
