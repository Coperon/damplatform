import * as bcrypt from 'bcryptjs';
import db from './db';
import { AppError } from './errors';

export function validatePasswordStrength(password: string) {
  const strong =
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
  if (!strong) {
    throw new AppError(
      400,
      'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.',
    );
  }
}

// createUser (public self-registration) was removed along with
// POST /api/auth/register — the only way a user row is ever created now is
// POST /api/invitations/redeem's own INSERT, which carries the invite's
// tenant_id/role_id. See that route.

export async function updatePassword(userId: string, newPassword: string) {
  if (!newPassword) {
    throw new AppError(400, 'New password is required');
  }
  validatePasswordStrength(newPassword);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [passwordHash, userId],
  );
}

export async function findByEmail(email: string) {
  const result = await db.query(
    `SELECT u.id, u.email, u.password_hash, u.name, u.status,
            u.tenant_id, u.role_id, u.can_access_all_tenants, u.can_invite, r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON u.role_id = r.id
     WHERE u.email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}
