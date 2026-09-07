import { cookies } from 'next/headers';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/sessionCookie';

export async function POST() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  return new Response(null, { status: 204 });
}
