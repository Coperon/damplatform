import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { requestEmailChange, cancelEmailChange } from '@/lib/emailChange';
import { AppError } from '@/lib/errors';

// Starts an email change — does NOT change users.email. Sends a confirmation
// link to the NEW address; only clicking it (POST /api/profile/email-change/
// confirm) ever writes the new address, so login keeps using the old one
// until then.
export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const newEmail =
    typeof body === 'object' && body !== null && 'newEmail' in body
      ? (body as { newEmail: unknown }).newEmail
      : undefined;
  if (typeof newEmail !== 'string') {
    return NextResponse.json({ error: 'newEmail is required' }, { status: 400 });
  }

  try {
    const result = await requestEmailChange(user.sub, user.email, newEmail);
    return NextResponse.json({
      message: `A confirmation link was sent to ${result.newEmail}.`,
      newEmail: result.newEmail,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

// Cancel a pending change — always the caller's own (userId comes from the
// token; there is no id in the request to spoof).
export async function DELETE(req: NextRequest) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;
  await cancelEmailChange(user.sub);
  return NextResponse.json({ message: 'Pending email change cancelled.' });
}
