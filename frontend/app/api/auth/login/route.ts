import { cookies } from 'next/headers';
import { login } from '@/lib/auth';
import { AppError } from '@/lib/errors';
import { rateLimitOr429 } from '@/lib/rateLimit';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/sessionCookie';

export async function POST(request: Request) {
  const limited = await rateLimitOr429(request, 'login', 10, 15 * 60);
  if (limited) return limited;

  try {
    const body = await request.json();
    const result = await login(body.email, body.password);
    const jar = await cookies();
    jar.set(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return Response.json({ user: result.user });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
