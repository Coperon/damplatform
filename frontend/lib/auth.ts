import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { findByEmail, updatePassword } from './users';
import { sendResetEmail } from './mail';
import { AppError } from './errors';
import { logAccess } from './accessLog';
import db from './db';

// Capability derives entirely from role_id (the legacy group_id/user_groups
// model has been dropped). Mapping: super_admin(1)/admin(2) get canAdmin;
// super_admin/admin/editor(1,2,3) get canUpload; everyone except pending(5)
// gets canDownload.
function deriveCapabilitiesFromRole(roleId: number | null | undefined) {
  const canAdmin = roleId === 1 || roleId === 2;
  const canUpload = canAdmin || roleId === 3;
  const canDownload = roleId != null && roleId !== 5;
  return { canAdmin, canUpload, canDownload };
}

// The single JWT-minting path — same claims, same signing, for every caller
// that establishes a session (login, and as of the auto-login-on-redeem
// change, POST /api/invitations/redeem). Takes the same row shape
// findByEmail returns; never duplicate this payload-building logic at a
// second call site.
export function mintSessionToken(user: {
  id: string;
  email: string;
  name?: string | null;
  tenant_id?: string | null;
  role_id?: number | null;
  role_name?: string | null;
  can_access_all_tenants?: boolean | null;
  can_invite?: boolean | null;
}) {
  const { canAdmin, canUpload, canDownload } = deriveCapabilitiesFromRole(user.role_id);
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name ?? null,
    canDownload,
    canUpload,
    canAdmin,
    tenantId: user.tenant_id ?? null,
    roleId: user.role_id,
    roleName: user.role_name,
    // Role 1 always has cross-tenant access by definition — hardcoded at
    // mint (and again in lib/session.ts's canAccessAllTenants helper),
    // never dependent on the column.
    canAccessAllTenants: user.role_id === 1 ? true : user.can_access_all_tenants === true,
    // Same pattern for invite authority — role 1 can always invite,
    // hardcoded at mint (and again in lib/session.ts's canInvite helper),
    // never dependent on the column.
    canInvite: user.role_id === 1 ? true : user.can_invite === true,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '1d',
  });

  return {
    access_token: token,
    user: { id: user.id, email: user.email, name: user.name ?? null },
  };
}

export async function login(email: string, password: string) {
  const user = await findByEmail(email);
  if (!user) {
    throw new AppError(401, 'Invalid email or password');
  }
  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    throw new AppError(401, 'Invalid email or password');
  }
  const result = mintSessionToken(user);

  // Only reached after the password check above already succeeded — a failed
  // login is never logged as activity here (see the two AppError throws
  // above). Fire-and-forget; never the password or the issued token, only who
  // logged in, their tenant, and their role.
  logAccess({
    userId: user.id,
    tenantId: user.tenant_id ?? null,
    resourceId: null,
    action: 'login',
    metadata: { roleName: user.role_name },
  });

  return result;
}

export async function changePassword(
  email: string,
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await findByEmail(email);
  if (!user) {
    throw new AppError(401, 'User not found');
  }
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    throw new AppError(401, 'Current password is incorrect');
  }
  await updatePassword(userId, newPassword);
  return { message: 'Password changed successfully' };
}

export async function forgotPassword(email: string) {
  const user = await findByEmail(email);

  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await db.query(
      `INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'reset', $3)`,
      [user.id, tokenHash, expiresAt],
    );

    const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const resetLink = `${baseUrl}/reset-password?token=${rawToken}`;
    await sendResetEmail(user.email, resetLink);
  }

  return { message: 'If that email is registered, a reset link has been sent.' };
}

export async function resetPassword(rawToken: string, newPassword: string) {
  if (!rawToken) {
    throw new AppError(401, 'Invalid or missing token');
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const result = await db.query(
    `SELECT id, user_id, expires_at, used_at
     FROM email_tokens
     WHERE token_hash = $1 AND purpose = 'reset'`,
    [tokenHash],
  );
  const tokenRow = result.rows[0];

  if (!tokenRow) {
    throw new AppError(401, 'Invalid token');
  }
  if (tokenRow.used_at) {
    throw new AppError(401, 'This reset link has already been used');
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    throw new AppError(401, 'This reset link has expired');
  }

  await updatePassword(tokenRow.user_id, newPassword);
  await db.query(
    'UPDATE email_tokens SET used_at = now() WHERE id = $1',
    [tokenRow.id],
  );

  return { message: 'Password has been reset. You can now log in.' };
}
