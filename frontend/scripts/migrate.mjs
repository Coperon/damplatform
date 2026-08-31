// Schema migration runner. Applies every .sql file in db/migrations/ that has
// not been applied yet, in filename order, each inside its own transaction.
//
//   node scripts/migrate.mjs           apply pending migrations
//   node scripts/migrate.mjs --status  list applied / pending, apply nothing
//
// Migrations are append-only: never edit a file that has already been applied
// on any environment — add a new numbered file instead. The runner records a
// sha256 of each file and refuses to continue if a previously-applied file has
// changed on disk, which is how a silent schema drift gets caught early.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch {
  // No .env.local (e.g. CI or a server) — rely on the real environment.
}

// Migrations prefer a direct (non-pooled) endpoint when one is configured.
// A transaction-mode pooler such as Neon's -pooler host hands each statement
// whatever backend is free, which is the wrong substrate for a long DDL
// transaction; the direct endpoint is a real session. Falls back to
// DATABASE_URL so a plain local Postgres, which has no such split, needs no
// extra configuration.
const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Neither DIRECT_DATABASE_URL nor DATABASE_URL is set.');
  process.exit(1);
}

if (process.env.DIRECT_DATABASE_URL) {
  console.log('Using DIRECT_DATABASE_URL (direct endpoint).');
} else if (/-pooler\./.test(connectionString)) {
  console.warn('Warning: DATABASE_URL looks like a pooled endpoint. Set DIRECT_DATABASE_URL to the non-pooled string for migrations.');
}

const statusOnly = process.argv.includes('--status');
const pool = new Pool({ connectionString });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`No migrations directory at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT filename, checksum FROM public.schema_migrations');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  // Drift check before applying anything — a changed file that is already
  // applied means the recorded history no longer describes the database.
  for (const file of files) {
    if (!applied.has(file)) continue;
    const current = sha256(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    if (current !== applied.get(file)) {
      console.error(`\n  ${file} has changed since it was applied.`);
      console.error('  Migrations are append-only. Revert it and add a new file instead.\n');
      process.exit(1);
    }
  }

  const pending = files.filter((f) => !applied.has(f));

  if (statusOnly) {
    for (const f of files) console.log(`  ${applied.has(f) ? 'applied' : 'PENDING'}  ${f}`);
    if (files.length === 0) console.log('  (no migration files)');
    return;
  }

  if (pending.length === 0) {
    console.log('Up to date — no pending migrations.');
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      // A pg_dump-derived migration typically contains
      //   SELECT pg_catalog.set_config('search_path', '', false);
      // so that every statement in it is schema-qualified. The `false` makes
      // that session-wide, not transaction-local, so it is still in force here
      // and would survive onto the pooled connection after release. Reset it
      // before the bookkeeping write: this runner's own table is qualified
      // above, but nothing else should inherit an empty search_path.
      await client.query('RESET search_path');
      await client.query(
        'INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)',
        [file, sha256(sql)],
      );
      await client.query('COMMIT');
      console.log(`  applied  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED   ${file}\n  ${err.message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  console.log(`\n${pending.length} migration(s) applied.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => pool.end());
