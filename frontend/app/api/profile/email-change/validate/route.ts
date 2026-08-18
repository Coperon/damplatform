import { NextRequest, NextResponse } from 'next/server';
import { validateEmailChangeToken } from '@/lib/emailChange';

// Public, no auth — the confirmation link is emailed to the NEW address, so
// it may well be opened on a different device/browser than the one that
// requested the change; that's the whole point. Read-only: never marks the
// token used, so an email client's link-prescanner GETting this page can't
// itself burn the single-use token before the real user clicks "Confirm."
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const result = await validateEmailChangeToken(token);
  if (result.status !== 'valid') {
    return NextResponse.json({ status: 'invalid' });
  }
  return NextResponse.json({ status: 'valid', newEmail: result.newEmail });
}
