import db from '@/lib/db';

// Without this, Next tries to prerender the route at build time, which means
// opening a database connection during `next build` — a build that then fails
// for a reason that has nothing to do with the build.
export const dynamic = 'force-dynamic';

// Short on purpose: an unreachable database should surface as a 503 in seconds,
// not sit until the platform kills the function. Sized above lib/db.ts's
// 10s connection timeout so that timeout is what fires, and reports.
export const maxDuration = 15;

// Unauthenticated by design — a health check that needs a token cannot be read
// by an uptime monitor. It therefore reports only what is safe to be public:
// whether the app is up, whether it can reach its database, and which build and
// region are serving. No error text is returned, because driver errors can carry
// the connection host; those go to the log instead.
export async function GET() {
  const startedAt = Date.now();
  let database: 'ok' | 'unreachable' = 'unreachable';

  try {
    await db.query('SELECT 1');
    database = 'ok';
  } catch (err) {
    console.error('[health] database check failed:', err);
  }

  const ok = database === 'ok';

  return Response.json(
    {
      status: ok ? 'ok' : 'degraded',
      database,
      // Both are set by Vercel and absent locally. Region is how you confirm the
      // function is actually running in fra1 rather than the iad1 default, and
      // commit is how you confirm which build is serving — the two things a
      // green "Ready" badge does not tell you.
      region: process.env.VERCEL_REGION ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
