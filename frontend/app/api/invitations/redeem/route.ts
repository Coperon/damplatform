import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import db from '@/lib/db';
import { validatePasswordStrength, findByEmail } from '@/lib/users';
import { AppError } from '@/lib/errors';
import { validateInvitationToken } from '@/lib/invitations';
import { mintSessionToken } from '@/lib/auth';

// Public, no auth — completes an invitation and logs the redeemed user in.
// On success it mints a session token via lib/auth.ts's mintSessionToken —
// the exact same claims/signing login() uses — so the caller (the
// redemption page) lands the user authenticated, no separate login step.
// A failed or reused redemption (any return before the transaction commits)
// never reaches the mint call and never produces a session.
export async function POST(req: NextRequest) {
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

  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  // Required server-side too, matching the redemption form — not just a
  // client-side check.
  const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 30) : '';
  if (!phone) {
    return NextResponse.json({ error: 'Phone is required' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  try {
    validatePasswordStrength(password);
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Re-validate the token here — never trust that an earlier call to
  // GET /api/invitations/validate/[token] is still true by the time this
  // request lands (the invite could have expired or been redeemed/revoked
  // in between).
  const validation = await validateInvitationToken(token);
  if (validation.status !== 'valid') {
    return NextResponse.json(
      { error: 'This invitation link is invalid or has expired.' },
      { status: 400 },
    );
  }
  const invitation = validation.invitation;

  // Email is authoritative from the invite, never from the request body —
  // the redemption form only ever displays it, locked.
  const email = invitation.email;

  const passwordHash = await bcrypt.hash(password, 10);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // The single-use gate: this UPDATE only succeeds once, ever, for a given
    // invite — a concurrent second redeem attempt (or a reused link) finds
    // 0 rows here and the whole transaction rolls back with nothing created.
    const accept = await client.query(
      `UPDATE invitations
       SET accepted_at = now()
       WHERE id = $1 AND accepted_at IS NULL AND expires_at > now()
       RETURNING id`,
      [invitation.id],
    );
    if (accept.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'This invitation link is invalid or has expired.' },
        { status: 400 },
      );
    }

    try {
      await client.query(
        `INSERT INTO users (email, password_hash, name, phone, status, tenant_id, role_id)
         VALUES ($1, $2, $3, $4, 'approved', $5, $6)`,
        [email, passwordHash, name, phone, invitation.tenantId, invitation.roleId],
      );
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
      }
      throw err;
    }

    // Tenant details (address/phone) are no longer collected here — the
    // super admin enters them at tenant creation (POST /api/tenants), so a
    // first-admin invite redeems identically to any other invite. A stray
    // tenantDetails field in the request body is simply ignored.
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Outside the transaction (and after releasing the client) since this only
  // reads through the shared pool: mint the session for the just-created
  // user via the same findByEmail() login() uses, rather than hand-building
  // the row here, so the minted claims (role, tenant, capability flags) can
  // never drift from what a normal login would produce for this account.
  const newUser = await findByEmail(email);
  const { access_token } = mintSessionToken(newUser!);

  return NextResponse.json(
    { message: 'Account created.', email, access_token },
    { status: 201 },
  );
}
