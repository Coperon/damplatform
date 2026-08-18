import * as crypto from 'crypto';
import db from './db';
import { AppError } from './errors';
import { sendEmailChangeConfirmation } from './mail';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 255;

// 24h, not the 30-minute password-reset window — this is a live logged-in
// user confirming a deliberate change, not "did I lose access to my
// account," so there's no urgency pushing the window shorter, and giving
// someone a real workday to check the new inbox avoids a dead link being
// the common case.
const EMAIL_CHANGE_EXPIRY_MS = 24 * 60 * 60 * 1000;

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Mirrors lib/auth.ts's forgotPassword/resetPassword token pattern exactly:
// a random raw token, sha256-hashed at rest in the same email_tokens table
// (purpose='email_change'), single-use via used_at, expiring. Deliberately
// sha256 (not bcrypt, like lib/shares.ts/lib/invitations.ts use) — sha256 is
// deterministic, so a direct `WHERE token_hash = $1` lookup works with just
// the raw token, no id+token composite needed, exactly like the reset flow.
export async function requestEmailChange(
  userId: string,
  currentEmail: string,
  rawNewEmail: string,
): Promise<{ newEmail: string; expiresAt: Date }> {
  const newEmail = typeof rawNewEmail === 'string' ? rawNewEmail.trim() : '';
  if (!newEmail || !EMAIL_RE.test(newEmail)) {
    throw new AppError(400, 'A valid email address is required');
  }
  if (newEmail.length > MAX_EMAIL_LENGTH) {
    throw new AppError(400, `Email must be ${MAX_EMAIL_LENGTH} characters or fewer`);
  }
  if (newEmail === currentEmail) {
    throw new AppError(400, 'That is already your email address');
  }

  // Same exact-match convention as every other email-uniqueness check in
  // this app (POST /api/invitations, users_email_key) — no LOWER(), emails
  // are compared case-sensitively throughout.
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [newEmail]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new AppError(409, 'That email address is already in use by another account');
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_EXPIRY_MS);

  // Only one pending change at a time — a fresh request supersedes any
  // earlier one (deleted, not left dangling) rather than leaving multiple
  // live tokens, and multiple stray confirmation emails, for the same user.
  await db.query(
    `DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'email_change' AND used_at IS NULL`,
    [userId],
  );
  await db.query(
    `INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at, new_email)
     VALUES ($1, $2, 'email_change', $3, $4)`,
    [userId, tokenHash, expiresAt, newEmail],
  );

  const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const confirmLink = `${baseUrl}/confirm-email?token=${rawToken}`;
  // Sent to the NEW address, never the old one — proving control of the new
  // address is the entire point. Never awaited-and-swallowed: a delivery
  // failure here should surface as a real error to the caller, not a
  // silent "sent" that never arrives.
  await sendEmailChangeConfirmation(newEmail, confirmLink, currentEmail);

  return { newEmail, expiresAt };
}

// Read for the Profile page's own pending-change banner — the row's
// existence (unused, unexpired) is exactly what "you have a pending email
// change" means; an expired-and-unused row is treated as if there were no
// pending change at all (the user would need to request again anyway).
export async function getPendingEmailChange(
  userId: string,
): Promise<{ newEmail: string; expiresAt: Date } | null> {
  const result = await db.query<{ new_email: string; expires_at: Date }>(
    `SELECT new_email, expires_at FROM email_tokens
     WHERE user_id = $1 AND purpose = 'email_change' AND used_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return row ? { newEmail: row.new_email, expiresAt: row.expires_at } : null;
}

// Cancel — deletes rather than marking used, so it simply stops existing
// (the Profile page's "Cancel change" button); the confirmation link, if
// already out in an inbox somewhere, then fails the same generic way an
// expired one would (see confirmEmailChange below), never a distinguishable
// "cancelled" message.
export async function cancelEmailChange(userId: string): Promise<void> {
  await db.query(
    `DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'email_change' AND used_at IS NULL`,
    [userId],
  );
}

// Read-only — the confirmation page's own load-time check, kept deliberately
// separate from confirmEmailChange (which performs the actual swap) so that
// an email client's link-prescanner (Outlook Safe Links and similar) GETting
// this page can never itself burn the single-use token; only an explicit
// button click calls the POST below.
export async function validateEmailChangeToken(
  rawToken: string,
): Promise<{ status: 'valid'; newEmail: string } | { status: 'invalid' }> {
  if (!rawToken) return { status: 'invalid' };
  const tokenHash = hashToken(rawToken);
  const result = await db.query<{ new_email: string; expires_at: Date; used_at: Date | null }>(
    `SELECT new_email, expires_at, used_at FROM email_tokens
     WHERE token_hash = $1 AND purpose = 'email_change'`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return { status: 'invalid' };
  if (row.used_at) return { status: 'invalid' };
  if (new Date(row.expires_at) < new Date()) return { status: 'invalid' };
  return { status: 'valid', newEmail: row.new_email };
}

// The actual swap — atomic single-use redemption, same shape as
// POST /api/invitations/redeem's accept-then-act UPDATE: the WHERE clause
// only ever matches an unused, unexpired row, so a reused or expired token
// affects 0 rows and the whole thing fails generically (one fixed message,
// no oracle distinguishing "never existed" from "already used" from
// "expired" from "cancelled").
export async function confirmEmailChange(rawToken: string): Promise<{ email: string }> {
  if (!rawToken) {
    throw new AppError(400, 'This confirmation link is invalid or has expired.');
  }
  const tokenHash = hashToken(rawToken);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const claim = await client.query<{ user_id: string; new_email: string }>(
      `UPDATE email_tokens
       SET used_at = now()
       WHERE token_hash = $1 AND purpose = 'email_change' AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, new_email`,
      [tokenHash],
    );
    if (claim.rowCount === 0) {
      throw new AppError(400, 'This confirmation link is invalid or has expired.');
    }
    const { user_id: userId, new_email: newEmail } = claim.rows[0];

    // Re-checked here, not just at request time — another account could
    // have taken this exact address in the meantime (its own pending
    // change confirmed first, or an admin edit). A conflict discovered here
    // is a genuine data race, not a token problem, so it gets its own
    // distinct message rather than the generic invalid-link one above.
    let email: string;
    try {
      const update = await client.query<{ email: string }>(
        `UPDATE users SET email = $1 WHERE id = $2 RETURNING email`,
        [newEmail, userId],
      );
      email = update.rows[0].email;
    } catch (err: any) {
      if (err.code === '23505') {
        throw new AppError(409, 'That email address is already in use by another account.');
      }
      throw err;
    }

    await client.query('COMMIT');
    return { email };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
