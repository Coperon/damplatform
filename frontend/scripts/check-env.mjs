// Environment preflight. Verifies that whatever DATABASE_URL and S3_* point at
// is actually usable by this application, and reports what is missing.
//
//   node scripts/check-env.mjs              check database + object storage
//   node scripts/check-env.mjs --db         database only
//   node scripts/check-env.mjs --storage    object storage only
//   node scripts/check-env.mjs --write      also do a real put/get/delete probe
//   node scripts/check-env.mjs --origin=https://dam.example.com
//                                           also check the bucket's CORS policy
//
// Read-only by default: it never writes to the database, and touches object
// storage only with --write (one small object, deleted again immediately).
//
// Point it at a new environment by overriding the vars for one command, e.g.
//   DATABASE_URL="postgres://...neon.tech/dam?sslmode=verify-full" node scripts/check-env.mjs --db

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  S3Client,
  ListObjectsV2Command,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Real environment wins; .env.local only fills the gaps. That ordering is what
// lets a one-off override above point this at Neon without editing any file.
const before = new Set(Object.keys(process.env));
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch {
  // No .env.local (CI, or a server) — rely on the real environment.
}
for (const k of Object.keys(process.env)) {
  if (!before.has(k)) continue;
}

const args = process.argv.slice(2);
const only = args.includes('--db') ? 'db' : args.includes('--storage') ? 'storage' : 'both';
const doWrite = args.includes('--write');
const originArg = args.find((a) => a.startsWith('--origin='));
const origin = originArg ? originArg.slice('--origin='.length) : null;

let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => { warnings++; console.log(`  ! ${m}`); };
const bad = (m) => { failures++; console.log(`  ✗ ${m}`); };
const head = (m) => console.log(`\n${m}\n${'-'.repeat(m.length)}`);

// Never print a credential. Show only enough to confirm which host was reached.
function describeDbUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname} (user ${u.username || '?'})`;
  } catch {
    return '(unparseable)';
  }
}

async function checkDatabase() {
  head('Database');
  const url = process.env.DATABASE_URL;
  if (!url) return bad('DATABASE_URL is not set.');
  console.log(`  target: ${describeDbUrl(url)}`);

  const isNeon = /\.neon\.tech/i.test(url);
  if (isNeon) {
    if (/-pooler\./i.test(url)) ok('Neon pooled endpoint (-pooler) — correct for the app.');
    else warn('Neon DIRECT endpoint. Fine for migrations; the app should use the -pooler string.');

    if (/sslmode=verify-full/i.test(url)) {
      ok('sslmode=verify-full — certificate is verified, and stays verified after a pg 9 upgrade.');
    } else if (/sslmode=require/i.test(url)) {
      warn('sslmode=require: pg 8 treats this as verify-full, but pg 9 will switch it to libpq semantics, which skip certificate verification. Prefer sslmode=verify-full.');
    } else {
      warn('No sslmode in the connection string. Neon requires TLS.');
    }

    const poolMax = process.env.PG_POOL_MAX;
    if (poolMax === '1') ok('PG_POOL_MAX=1 — correct for serverless.');
    else warn(`PG_POOL_MAX is ${poolMax ?? 'unset (default 10)'}. Set it to 1 on Vercel.`);
  }

  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15_000, max: 1 });
  try {
    const v = await pool.query('SELECT version(), current_database() AS db');
    const version = v.rows[0].version.split(' ').slice(0, 2).join(' ');
    ok(`connected — ${version}, database "${v.rows[0].db}"`);

    // "Installed" and "available" are different questions, and only the second
    // one is fatal. On a fresh database nothing is installed yet — that is
    // normal, because 0001_baseline.sql does the CREATE EXTENSION itself. What
    // would actually sink the migration is the server not offering the
    // extension at all, or the role not being allowed to create it.
    const ext = await pool.query(
      `SELECT a.name,
              a.default_version,
              (e.extname IS NOT NULL) AS installed
         FROM pg_available_extensions a
         LEFT JOIN pg_extension e ON e.extname = a.name
        WHERE a.name IN ('pg_trgm','pgcrypto')`);
    const seen = new Map(ext.rows.map((r) => [r.name, r]));
    for (const e of ['pg_trgm', 'pgcrypto']) {
      const row = seen.get(e);
      if (!row) bad(`extension ${e} is NOT AVAILABLE on this server — 0001_baseline.sql cannot run.`);
      else if (row.installed) ok(`extension ${e} installed`);
      else ok(`extension ${e} available (v${row.default_version}), not yet installed — 0001_baseline.sql creates it`);
    }

    const t = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    if (t.rows[0].n === 0) {
      bad('database is EMPTY (0 tables). The app will connect and then fail every query — load the schema and data first.');
      return;
    }
    ok(`${t.rows[0].n} tables present`);

    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM resources)   AS resources,
              (SELECT count(*) FROM users)       AS users,
              (SELECT count(*) FROM collections) AS collections`);
    const c = counts.rows[0];
    console.log(`  rows: ${c.resources} resources / ${c.users} users / ${c.collections} collections  (dev baseline: 136 / 9 / 32)`);

    const gen = await pool.query(
      `SELECT is_generated FROM information_schema.columns
        WHERE table_name = 'resources' AND column_name = 'search_vector'`);
    if (gen.rowCount === 0) bad('resources.search_vector is MISSING — search will return nothing.');
    else if (gen.rows[0].is_generated === 'ALWAYS') ok('resources.search_vector is a generated column');
    else warn(`resources.search_vector exists but is_generated = ${gen.rows[0].is_generated}`);

    const mig = await pool.query(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
    if (!mig.rows[0].present) {
      warn('no schema_migrations table — the migration ledger has not been initialised here. Run: node scripts/migrate.mjs --status');
    } else {
      const applied = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
      if (applied.rowCount === 0) warn('schema_migrations exists but is EMPTY, while tables are present — the ledger does not describe this database. See plan 3.1 step 3.');
      else ok(`migration ledger: ${applied.rows.map((r) => r.filename).join(', ')}`);
    }
  } catch (err) {
    bad(`connection failed: ${err.message}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkStorage() {
  head('Object storage');
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION } = process.env;
  const missing = Object.entries({ S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return bad(`not set: ${missing.join(', ')}`);

  console.log(`  target: ${S3_ENDPOINT} bucket "${S3_BUCKET}" region "${S3_REGION ?? '(default us-east-1)'}"`);

  const isR2 = /\.r2\.cloudflarestorage\.com/i.test(S3_ENDPOINT);
  if (isR2) {
    if (S3_REGION === 'auto') ok('S3_REGION=auto — correct for R2.');
    else bad(`R2 endpoint but S3_REGION is "${S3_REGION ?? 'unset'}". R2 requires "auto".`);
    if (!S3_ENDPOINT.startsWith('https://')) bad('R2 endpoint must be https://');
  }

  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION ?? 'us-east-1',
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    ok(`bucket "${S3_BUCKET}" reachable and credentials accepted`);
  } catch (err) {
    return bad(`cannot reach bucket: ${err.name} ${err.message}`);
  }

  try {
    let token, n = 0, bytes = 0;
    do {
      const r = await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, ContinuationToken: token }));
      for (const o of r.Contents ?? []) { n++; bytes += o.Size; }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    ok(`list: ${n} objects, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  } catch (err) {
    bad(`list failed (token may lack read permission): ${err.message}`);
  }

  if (doWrite) {
    const key = `_preflight/${randomUUID()}.txt`;
    const body = Buffer.from('preflight');
    try {
      await client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: 'text/plain' }));
      const got = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      const back = Buffer.from(await got.Body.transformToByteArray());
      if (back.equals(body)) ok('write probe: put + get round-tripped identical bytes');
      else bad('write probe: bytes came back DIFFERENT');
      await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      ok('write probe: probe object deleted');
    } catch (err) {
      bad(`write probe failed (token may be read-only): ${err.message}`);
      try { await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })); } catch {}
    }
  } else {
    console.log('  (skipped put/get/delete probe — pass --write to include it)');
  }

  // CORS is browser-enforced, so the only honest check is a real preflight
  // request. The browser PUTs uploads and fetches every thumbnail/cover/download
  // straight from this endpoint, cross-origin; MinIO allows that by default and
  // R2 denies it, which is the single most likely way a migrated app "works"
  // right up until someone uploads or views a file.
  if (origin) {
    for (const method of ['PUT', 'GET']) {
      try {
        // Only the upload leg sends Content-Type, so only it should ask for that
        // header in the preflight. Asking on the GET leg too would fail a bucket
        // whose rules are correct but tight (B2's own read-only preset allows
        // just "authorization, range"), reporting a problem that is not there.
        const headers = {
          Origin: origin,
          'Access-Control-Request-Method': method,
        };
        if (method === 'PUT') headers['Access-Control-Request-Headers'] = 'content-type';
        const res = await fetch(`${S3_ENDPOINT.replace(/\/$/, '')}/${S3_BUCKET}/_cors-probe`, {
          method: 'OPTIONS',
          headers,
        });
        const allow = res.headers.get('access-control-allow-origin');
        if (allow === origin || allow === '*') ok(`CORS ${method}: allowed for ${origin}`);
        else bad(`CORS ${method}: not allowed for ${origin} (Access-Control-Allow-Origin: ${allow ?? 'absent'}, HTTP ${res.status})`);
      } catch (err) {
        warn(`CORS ${method}: preflight request failed: ${err.message}`);
      }
    }
  } else {
    console.log('  (skipped CORS check — pass --origin=https://your-app-domain to include it)');
  }
}

if (only === 'db' || only === 'both') await checkDatabase();
if (only === 'storage' || only === 'both') await checkStorage();

console.log();
if (failures) {
  console.log(`FAILED — ${failures} problem(s)${warnings ? `, ${warnings} warning(s)` : ''}.`);
  process.exit(1);
}
console.log(warnings ? `OK with ${warnings} warning(s).` : 'All checks passed.');
