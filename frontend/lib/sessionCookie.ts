export const SESSION_COOKIE = 'dam_session';

const MAX_AGE = 60 * 60 * 24; // matches jwt expiresIn 1d

export function sessionCookieSecure(): boolean {
  return process.env.VERCEL === '1' || (process.env.APP_URL || '').startsWith('https');
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: sessionCookieSecure(),
    path: '/',
    maxAge: MAX_AGE,
  };
}

export function readSessionToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value || null;
  }
  return null;
}
