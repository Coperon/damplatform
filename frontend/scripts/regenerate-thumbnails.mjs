// Bulk backfill: force-regenerate video/PDF/image thumbnails (or, with
// --missing, generate a first thumbnail for resources that don't have one
// yet) through the real POST /api/resources/[id]/thumbnail endpoint — this
// script only enumerates candidates and drives that endpoint over HTTP; it
// never reimplements ffmpeg/pdfjs/canvas rendering itself.
//
// Two use cases:
//  - Regenerate (default): thumbnails rendered before a pipeline change (e.g.
//    the PDF path's 320px -> 800px width bump) are still sitting at the old
//    resolution, since the endpoint's default (non-force) behavior
//    short-circuits and never re-renders an already-thumbnailed resource.
//    Targets resources that already have a thumbnail_storage_key.
//  - Backfill (--missing): give a first thumbnail to resources that never
//    got one — e.g. images uploaded before the image thumbnail pipeline
//    existed. Targets resources with no thumbnail_storage_key.
//
// Requires a running server (dev or prod) and an admin JWT supplied via the
// ADMIN_TOKEN environment variable — never hardcode or write a token to disk.
// Log in as an admin (e.g. via the app or curl to /api/auth/login) and export
// the returned token before running this script:
//
//   ADMIN_TOKEN=eyJ... node scripts/regenerate-thumbnails.mjs
//   ADMIN_TOKEN=eyJ... node scripts/regenerate-thumbnails.mjs --type=pdf
//   ADMIN_TOKEN=eyJ... node scripts/regenerate-thumbnails.mjs --type=video
//   ADMIN_TOKEN=eyJ... node scripts/regenerate-thumbnails.mjs --type=image
//   ADMIN_TOKEN=eyJ... node scripts/regenerate-thumbnails.mjs --missing
//   ADMIN_TOKEN=eyJ... node scripts/regenerate-thumbnails.mjs --missing --type=image
//
// Not run automatically — manual invocation only.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch (err) {
  console.error(`Could not load .env.local (${err.message}) — proceeding with existing environment.`);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error('ADMIN_TOKEN is not set. Log in as an admin and pass the JWT via the ADMIN_TOKEN env var.');
  process.exit(1);
}

const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';

const args = process.argv.slice(2);
const typeArg = args.find((a) => a.startsWith('--type='))?.split('=')[1];
const missingOnly = args.includes('--missing');
if (typeArg && !['pdf', 'video', 'image'].includes(typeArg)) {
  console.error(`Unknown --type=${typeArg}. Expected --type=pdf, --type=video, or --type=image.`);
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Kept in sync with SUPPORTED_IMAGE_MIME_TYPES in
// app/api/resources/[id]/thumbnail/route.ts and the client-side
// supportsGeneratedThumbnail() helpers.
const TYPE_FILTER = {
  pdf: "mime_type = 'application/pdf'",
  video: "mime_type LIKE 'video/%'",
  image: "mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')",
};
const mimeClause = typeArg
  ? TYPE_FILTER[typeArg]
  : `(${TYPE_FILTER.pdf} OR ${TYPE_FILTER.video} OR ${TYPE_FILTER.image})`;
const keyClause = missingOnly ? 'thumbnail_storage_key IS NULL' : 'thumbnail_storage_key IS NOT NULL';

async function fetchCandidates() {
  const { rows } = await pool.query(
    `SELECT id, mime_type, original_filename
       FROM resources
      WHERE ${keyClause}
        AND ${mimeClause}
      ORDER BY created_at ASC`,
  );
  return rows;
}

async function regenerateOne(resource) {
  // force=true is a no-op for a resource with no existing thumbnail (the
  // endpoint's short-circuit only ever triggers when a key already exists),
  // so it's safe to always pass it rather than branching on --missing.
  const res = await fetch(`${baseUrl}/api/resources/${resource.id}/thumbnail?force=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (res.ok) {
    return { outcome: 'regenerated' };
  }

  // A resource that vanished or no longer qualifies mid-run isn't a pipeline
  // failure — count it separately from a real render/storage error.
  if (res.status === 404 || res.status === 400) {
    const body = await res.json().catch(() => ({}));
    return { outcome: 'skipped', reason: `${res.status} ${body.error ?? ''}`.trim() };
  }

  const body = await res.json().catch(() => ({}));
  return { outcome: 'failed', reason: `${res.status} ${body.error ?? ''}`.trim() };
}

async function main() {
  const candidates = await fetchCandidates();
  const verb = missingOnly ? 'generate a first thumbnail for' : 'regenerate';
  console.log(`Found ${candidates.length} ${typeArg ?? 'video/PDF/image'} resource(s) to ${verb}.`);

  let regenerated = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const resource = candidates[i];
    const label = `[${i + 1}/${candidates.length}] ${resource.original_filename} (${resource.mime_type})`;

    try {
      const { outcome, reason } = await regenerateOne(resource);
      if (outcome === 'regenerated') {
        regenerated++;
        console.log(`${label} -> regenerated`);
      } else if (outcome === 'skipped') {
        skipped++;
        console.log(`${label} -> skipped (${reason})`);
      } else {
        failed++;
        console.log(`${label} -> failed (${reason})`);
      }
    } catch (err) {
      failed++;
      console.log(`${label} -> failed (${err.message})`);
    }
  }

  console.log('--- Thumbnail regeneration summary ---');
  console.log(`Candidates found: ${candidates.length}`);
  console.log(`Regenerated:      ${regenerated}`);
  console.log(`Failed:           ${failed}`);
  console.log(`Skipped:          ${skipped}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await pool.end();
  process.exitCode = 1;
});
