import bcrypt from 'bcryptjs';
import db from './db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Roles an invitation may ever target — never super_admin(1, minted only by
// direct DB/PATCH by another super admin) or pending(5, not an invited state).
export const INVITABLE_ROLES = new Set([2, 3, 4]);
// Roles a tenant admin (as opposed to a super admin) may invite — mirrors
// PATCH /api/users/[id]'s TENANT_ADMIN_ASSIGNABLE_ROLES: only a super admin
// mints admins.
export const TENANT_ADMIN_INVITABLE_ROLES = new Set([3, 4]);

export interface InvitationRow {
  id: string;
  email: string;
  tenantId: string;
  roleId: number;
}

export type InvitationValidation =
  | { status: 'valid'; invitation: InvitationRow }
  | { status: 'invalid' };

// Splits "{invitationId}.{rawToken}" on the first '.', same shape as shares'
// {shareId}.{rawToken} — the id half is a uuid (never contains a dot), the
// token half is base64url (also never contains a dot).
function parseInvitationParam(param: string): { id: string; rawToken: string } | null {
  const dotIndex = param.indexOf('.');
  if (dotIndex === -1) return null;
  const id = param.slice(0, dotIndex);
  const rawToken = param.slice(dotIndex + 1);
  if (!UUID_RE.test(id) || !rawToken) return null;
  return { id, rawToken };
}

// The single gate every invitation-consuming endpoint calls first (validate
// and redeem both re-run this — redeem never trusts a prior validate call).
// Fails closed to one generic 'invalid' result for every failure mode: bad
// param shape, no such row, wrong token, already-accepted, or expired — no
// oracle distinguishing any of them, deliberately stricter than shares'
// validateShareToken (which does distinguish expired/revoked for UX; this
// endpoint is asked not to).
export async function validateInvitationToken(param: string): Promise<InvitationValidation> {
  const parsed = parseInvitationParam(param);
  if (!parsed) return { status: 'invalid' };

  const result = await db.query(
    `SELECT id, token_hash, email, tenant_id, role_id, expires_at, accepted_at
     FROM invitations WHERE id = $1`,
    [parsed.id],
  );
  const row = result.rows[0];
  if (!row) return { status: 'invalid' };

  const matches = await bcrypt.compare(parsed.rawToken, row.token_hash);
  if (!matches) return { status: 'invalid' };

  if (row.accepted_at) return { status: 'invalid' };
  if (new Date(row.expires_at) < new Date()) return { status: 'invalid' };

  return {
    status: 'valid',
    invitation: {
      id: row.id,
      email: row.email,
      tenantId: row.tenant_id,
      roleId: row.role_id,
    },
  };
}
