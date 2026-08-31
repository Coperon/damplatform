import { Pool } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

// Read a non-negative integer from the environment, falling back when unset,
// blank, or unparseable. Written so an explicit 0 is honoured (pg reads 0 as
// "no timeout" for the two timeout knobs below) rather than swallowed by a
// `|| fallback`.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// Pool size is configuration, not a constant. A long-lived server wants a
// real pool; a serverless instance wants a tiny one, because every warm
// instance holds its own pool against the same database and they all count
// against the same connection limit — an unbounded pool times N warm
// instances is how a serverless deployment exhausts Postgres. The default of
// 10 matches pg's own, so an existing server deployment behaves exactly as
// before; set PG_POOL_MAX=1 on a serverless host.
//
// PG_POOL_MAX=1 is only safe because no route holds a transaction client
// while issuing a second query through the pool. That invariant is real but
// fragile — it was violated by both upload routes until this was written, and
// the failure mode is a permanent hang, not an error. Re-check it before
// lowering this, and see the comment in app/api/upload/complete/route.ts.
const max = Math.max(1, envInt('PG_POOL_MAX', 10));

const db =
  global._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    // A serverless instance is frozen between requests, and its idle sockets
    // get reaped by the platform or by the database's own idle timeout while
    // it sleeps. Discarding them on our side first means the pool never hands
    // out a socket that is already dead.
    idleTimeoutMillis: envInt('PG_IDLE_TIMEOUT_MS', 10_000),
    // Bound the wait for a connection instead of hanging forever (pg's
    // default). A request that cannot get a connection should fail visibly
    // rather than sit until the platform kills the whole function. Set 0 to
    // restore the wait-forever behaviour.
    connectionTimeoutMillis: envInt('PG_CONNECT_TIMEOUT_MS', 10_000),
  });
if (process.env.NODE_ENV !== 'production') global._pgPool = db;

export default db;
