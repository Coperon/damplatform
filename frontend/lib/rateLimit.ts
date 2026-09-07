import db from '@/lib/db';

export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);
  return 'unknown';
}

/**
 * Postgres-backed limiter for public auth/share routes (no Redis on this stack).
 * Returns a 429 Response when the IP has exceeded `limit` hits in `windowSeconds`.
 * On unexpected DB errors, fail open so a missing table cannot take down login.
 */
export async function rateLimitOr429(
  request: Request,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const ip = clientIp(request);
  try {
    if (Math.random() < 0.02) {
      await db.query(
        `DELETE FROM rate_limit_events WHERE created_at < now() - interval '2 days'`,
      );
    }
    const counted = await db.query(
      `SELECT count(*)::int AS n FROM rate_limit_events
       WHERE bucket = $1 AND ip = $2
         AND created_at > now() - ($3::int * interval '1 second')`,
      [bucket, ip, windowSeconds],
    );
    const n: number = counted.rows[0]?.n ?? 0;
    if (n >= limit) {
      return Response.json({ message: 'Too many requests' }, { status: 429 });
    }
    await db.query(
      `INSERT INTO rate_limit_events (bucket, ip) VALUES ($1, $2)`,
      [bucket, ip],
    );
    return null;
  } catch (err) {
    console.error('rateLimitOr429 failed; allowing request', err);
    return null;
  }
}
