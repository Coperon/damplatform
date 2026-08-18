import { NextRequest, NextResponse } from 'next/server';
import { confirmEmailChange } from '@/lib/emailChange';
import { AppError } from '@/lib/errors';

// Public, no auth — same reasoning as validate/route.ts. This is the one
// call that actually writes users.email; the confirm-email page only fires
// it on an explicit button click, never automatically on load.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (typeof raw !== 'object' || raw === null) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';

  try {
    const result = await confirmEmailChange(token);
    return NextResponse.json({ message: 'Email address updated.', email: result.email });
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
