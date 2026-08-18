import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, canAccessAllTenants } from '@/lib/session';
import { logAccess } from '@/lib/accessLog';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Roles a tenant admin may assign — editor and viewer only. Neither
// super_admin(1) nor admin(2) (only a super admin mints admins) nor
// pending(5) (not part of this action) is reachable by a tenant admin.
const TENANT_ADMIN_ASSIGNABLE_ROLES = new Set([3, 4]);

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { id } = await ctx.params;

  // Block self-edit — prevents an admin from removing their own admin access
  // (also covers name for simplicity; an admin can still be renamed by another admin)
  if (id === admin.sub) {
    return NextResponse.json(
      { error: 'You cannot edit your own account here.' },
      { status: 403 },
    );
  }

  const superAdmin = isSuperAdmin(admin);

  // Tenant-scoped enforcement: a regular tenant admin may only modify a user
  // in their own tenant (from the token, never a request param); an admin
  // with cross-tenant access (role 2 + can_access_all_tenants) may modify a
  // user in ANY tenant — the "third branch." Neither may touch an
  // admin-tier target (role 1 or 2) on any field, not just role/tenant:
  // cross-tenant access makes you a full admin everywhere, and a full
  // tenant admin can't edit peer admins either — the
  // "super admin owns the admin slot" boundary is unchanged. Checked before
  // looking at the body at all, so a name-only edit is covered too. Fail
  // closed: a tenant admin with no tenantId can modify no one. All branches
  // return the same generic message so a 403 never distinguishes "wrong
  // tenant" from "target is admin-tier."
  if (!superAdmin) {
    const targetLookup = await db.query<{ tenant_id: string | null; role_id: number }>(
      'SELECT tenant_id, role_id FROM users WHERE id = $1',
      [id],
    );
    if (targetLookup.rowCount === 0) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const target = targetLookup.rows[0];
    if (target.role_id === 1 || target.role_id === 2) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    if (!canAccessAllTenants(admin)) {
      if (!admin.tenantId || target.tenant_id !== admin.tenantId) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if ('roleId' in body) {
    const roleId = (body as { roleId: unknown }).roleId;
    if (typeof roleId !== 'number' || !Number.isInteger(roleId)) {
      return NextResponse.json({ error: 'roleId must be an integer' }, { status: 400 });
    }

    const roleCheck = await db.query('SELECT id FROM roles WHERE id = $1', [roleId]);
    if (roleCheck.rows.length === 0) {
      return NextResponse.json({ error: `Role ${roleId} does not exist` }, { status: 400 });
    }

    // Privilege-escalation guard: only a super admin may grant super_admin or
    // admin — a tenant admin is restricted to editor/viewer (Stage 7
    // decision: "only super admins mint admins").
    if (!superAdmin && !TENANT_ADMIN_ASSIGNABLE_ROLES.has(roleId)) {
      return NextResponse.json(
        { error: 'Only a super admin can assign this role' },
        { status: 403 },
      );
    }

    params.push(roleId);
    setClauses.push(`role_id = $${params.length}`);
  }

  if ('tenantId' in body) {
    // Only a super admin may move a user between tenants (or clear it) —
    // a tenant admin can never set/change a user's tenant, on themself or
    // anyone else.
    if (!superAdmin) {
      return NextResponse.json(
        { error: 'Only a super admin can change a user’s company' },
        { status: 403 },
      );
    }

    const tenantId = (body as { tenantId: unknown }).tenantId;
    if (tenantId === null) {
      // "None" — valid on its own (super admins have no tenant), never
      // silently coerced from a bad value; only an explicit null takes it.
      setClauses.push(`tenant_id = NULL`);
    } else {
      if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
        return NextResponse.json({ error: 'tenantId must be a uuid or null' }, { status: 400 });
      }

      // Fail closed: validate against the real tenants table, never insert
      // an id that doesn't exist there.
      const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
      if (tenantCheck.rows.length === 0) {
        return NextResponse.json({ error: `Company ${tenantId} does not exist` }, { status: 400 });
      }

      params.push(tenantId);
      setClauses.push(`tenant_id = $${params.length}`);
    }
  }

  if ('name' in body) {
    const name = (body as { name: unknown }).name;
    if (typeof name !== 'string') {
      return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
    }
    const trimmed = name.trim().slice(0, 100);
    params.push(trimmed || null);
    setClauses.push(`name = $${params.length}`);
  }

  let allTenantsFlagChange: boolean | null = null;
  if ('canAccessAllTenants' in body) {
    // The self-escalation guard: ONLY a super admin may set or unset
    // can_access_all_tenants — an admin with the flag attempting it (on
    // anyone, including themselves) gets 403, so cross-tenant access can
    // never mint more cross-tenant access. Checked before validating the
    // value, so even a malformed attempt by a non-super-admin reads as a
    // permission problem, not a validation one.
    if (!superAdmin) {
      return NextResponse.json(
        { error: 'Only a super admin can change cross-tenant access' },
        { status: 403 },
      );
    }
    const flag = (body as { canAccessAllTenants: unknown }).canAccessAllTenants;
    if (typeof flag !== 'boolean') {
      return NextResponse.json({ error: 'canAccessAllTenants must be a boolean' }, { status: 400 });
    }
    allTenantsFlagChange = flag;
    params.push(flag);
    setClauses.push(`can_access_all_tenants = $${params.length}`);
  }

  let inviteFlagChange: boolean | null = null;
  if ('canInvite' in body) {
    // Same self-escalation guard as canAccessAllTenants above: ONLY a super admin may
    // set or unset can_invite — anyone else attempting it, on any target
    // including themselves, gets 403 (self-grant is already covered by the
    // unconditional self-edit block at the top of this handler, before the
    // body is even parsed). Checked before validating the value.
    if (!superAdmin) {
      return NextResponse.json(
        { error: 'Only a super admin can change invite access' },
        { status: 403 },
      );
    }
    const flag = (body as { canInvite: unknown }).canInvite;
    if (typeof flag !== 'boolean') {
      return NextResponse.json({ error: 'canInvite must be a boolean' }, { status: 400 });
    }
    inviteFlagChange = flag;
    params.push(flag);
    setClauses.push(`can_invite = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
  }

  // Update — rowCount 0 means the target user id doesn't exist (the
  // same-tenant check above already ruled out "exists in another tenant"
  // for a tenant admin, so a 404 here is a genuine race, not a leak).
  params.push(id);
  const result = await db.query<{
    id: string;
    email: string;
    name: string | null;
    tenant_id: string | null;
    role_id: number;
    can_access_all_tenants: boolean;
    can_invite: boolean;
  }>(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${params.length}
     RETURNING id, email, name, tenant_id, role_id, can_access_all_tenants, can_invite`,
    params,
  );

  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Audit trail for the flag: fire-and-forget, only after the UPDATE actually
  // landed. tenant_id is null (the actor is always a super admin, who has no
  // tenant), so tenant-scoped activity feeds never surface it — only a super
  // admin's unscoped feed does. Metadata carries the target and new value,
  // never anything secret.
  if (allTenantsFlagChange !== null) {
    logAccess({
      userId: admin.sub,
      tenantId: admin.tenantId ?? null,
      resourceId: null,
      action: 'all_tenants_flag_change',
      metadata: {
        targetUserId: result.rows[0].id,
        targetEmail: result.rows[0].email,
        newValue: allTenantsFlagChange,
      },
    });
  }

  // Same audit shape as all_tenants_flag_change above — fire-and-forget, only
  // after the UPDATE actually landed, tenant_id null (the actor is always a
  // super admin here, who has no tenant).
  if (inviteFlagChange !== null) {
    logAccess({
      userId: admin.sub,
      tenantId: admin.tenantId ?? null,
      resourceId: null,
      action: 'invite_flag_change',
      metadata: {
        targetUserId: result.rows[0].id,
        targetEmail: result.rows[0].email,
        newValue: inviteFlagChange,
      },
    });
  }

  return NextResponse.json(result.rows[0]);
}

// Permanent account deletion. Same tier boundaries as PATCH above (self-edit
// guard, peer-admin lock, own-tenant-vs-cross-tenant), plus two rules unique
// to delete: a super admin may never be left at zero (the lockout guard
// below), and a successful delete is recorded to access_log so the account's
// existence survives its own removal, same as every other FK this stage
// pointed at users.SET NULL for.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { id } = await ctx.params;

  // Never yourself, regardless of tier — checked before anything else, same
  // placement/spirit as PATCH's unconditional self-edit guard above.
  if (id === admin.sub) {
    return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 403 });
  }

  const superAdmin = isSuperAdmin(admin);
  const crossTenant = canAccessAllTenants(admin);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the target row for the duration of this transaction — needed
    // below so a concurrent delete of a different super admin can't race
    // the lockout count (see the FOR UPDATE on all role-1 rows further down).
    const targetResult = await client.query<{
      id: string;
      email: string;
      name: string | null;
      tenant_id: string | null;
      role_id: number;
    }>('SELECT id, email, name, tenant_id, role_id FROM users WHERE id = $1 FOR UPDATE', [id]);

    if (targetResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const target = targetResult.rows[0];

    if (!superAdmin) {
      // Same peer-admin lock as PATCH: a tenant admin (with or without
      // cross-tenant access) may never delete an admin-tier target (role 1
      // or 2), on any field, ever — not just role/tenant.
      if (target.role_id === 1 || target.role_id === 2) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
      // A plain tenant admin (no cross-tenant access) is further restricted
      // to their own tenant; a cross-tenant admin (role 2 +
      // can_access_all_tenants) may reach role 3/4 in any tenant, same as
      // every other cross-tenant-scoped route. Fail closed on a missing
      // tenantId.
      if (!crossTenant) {
        if (!admin.tenantId || target.tenant_id !== admin.tenantId) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: 'Access denied' }, { status: 403 });
        }
      }
    } else if (target.role_id === 1) {
      // Lockout guard, super-admin-only path: never let a delete leave zero
      // super admins. Lock every role-1 row (not just the target's) so two
      // concurrent deletes of two *different* super admins can't both pass
      // an independent count check and jointly zero the tier — the second
      // transaction blocks on this SELECT until the first commits (or rolls
      // back), then re-counts against the now-reduced, already-committed set.
      const superAdmins = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE role_id = 1 FOR UPDATE',
      );
      if ((superAdmins.rowCount ?? 0) <= 1) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Cannot delete the last remaining super admin.' },
          { status: 409 },
        );
      }
    }

    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');

    // Fire-and-forget, only after the DELETE actually committed. The target
    // row is gone, so every identifying field it carried is captured here by
    // value rather than left to a join that would now return nothing —
    // mirrors the all_tenants_flag_change/invite_flag_change convention
    // above, and the access_log/collections/resources/shares FKs' own
    // ON DELETE SET NULL, which exists for exactly this reason.
    logAccess({
      userId: admin.sub,
      tenantId: admin.tenantId ?? null,
      resourceId: null,
      action: 'user_delete',
      metadata: {
        targetUserId: target.id,
        targetEmail: target.email,
        targetName: target.name,
        targetRoleId: target.role_id,
        targetTenantId: target.tenant_id,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
