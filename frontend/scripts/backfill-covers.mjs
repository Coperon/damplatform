// One-time backfill: set collections.cover_storage_key for existing collections
// that have none. Candidate search order: the oldest image/* directly in the
// collection, then the oldest directly-member resource with a
// thumbnail_storage_key (video/PDF), then — new — the same two rules applied
// across the collection's descendant subtree (a container collection that
// holds only sub-collections has no direct files and would otherwise never
// get a cover, no matter how many images live underneath it), preferring the
// shallowest descendant depth and then the oldest created_at, so a cover comes
// from the nearest child rather than an arbitrarily deep leaf.
//
// Idempotent: every write uses `AND cover_storage_key IS NULL`, and the
// candidate scan itself only looks at collections with no cover, so re-running
// touches nothing already set (by this script, an upload, or a manual
// "Change thumbnail"). Not run automatically — invoke manually:
//
//   node scripts/backfill-covers.mjs

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

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Single parameterized query (static recursive CTE, only $1 bound): ranks
// candidates by priority (0 = own image, 1 = own thumbnail, 2 = descendant
// image, 3 = descendant thumbnail), then by subtree depth, then by
// created_at, and returns just the best one. `priority <= 1` means the cover
// came from the collection's own files; `priority >= 2` means it came from a
// descendant.
const CANDIDATE_QUERY = `
  WITH RECURSIVE subtree AS (
    SELECT id, 0 AS depth FROM collections WHERE id = $1
    UNION ALL
    SELECT c.id, s.depth + 1
    FROM collections c
    INNER JOIN subtree s ON c.parent_id = s.id
  )
  SELECT key, priority FROM (
    SELECT r.storage_key AS key, 0 AS priority, 0 AS depth, r.created_at AS created_at
    FROM resources r
    INNER JOIN collection_resource cr ON cr.resource_id = r.id
    WHERE cr.collection_id = $1 AND r.mime_type LIKE 'image/%'

    UNION ALL

    SELECT r.thumbnail_storage_key AS key, 1 AS priority, 0 AS depth, r.created_at AS created_at
    FROM resources r
    INNER JOIN collection_resource cr ON cr.resource_id = r.id
    WHERE cr.collection_id = $1 AND r.thumbnail_storage_key IS NOT NULL

    UNION ALL

    SELECT r.storage_key AS key, 2 AS priority, s.depth AS depth, r.created_at AS created_at
    FROM resources r
    INNER JOIN collection_resource cr ON cr.resource_id = r.id
    INNER JOIN subtree s ON s.id = cr.collection_id
    WHERE s.depth > 0 AND r.mime_type LIKE 'image/%'

    UNION ALL

    SELECT r.thumbnail_storage_key AS key, 3 AS priority, s.depth AS depth, r.created_at AS created_at
    FROM resources r
    INNER JOIN collection_resource cr ON cr.resource_id = r.id
    INNER JOIN subtree s ON s.id = cr.collection_id
    WHERE s.depth > 0 AND r.thumbnail_storage_key IS NOT NULL
  ) candidates
  ORDER BY priority ASC, depth ASC, created_at ASC
  LIMIT 1
`;

async function findCoverCandidate(collectionId) {
  const result = await pool.query(CANDIDATE_QUERY, [collectionId]);
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

async function main() {
  const { rows: coverless } = await pool.query(
    'SELECT id, name FROM collections WHERE cover_storage_key IS NULL',
  );

  let coveredOwn = 0;
  let coveredDescendant = 0;
  let skipped = 0;
  let noCandidate = 0;

  for (const collection of coverless) {
    const candidate = await findCoverCandidate(collection.id);

    if (!candidate) {
      noCandidate++;
      continue;
    }

    const result = await pool.query(
      'UPDATE collections SET cover_storage_key = $1 WHERE id = $2 AND cover_storage_key IS NULL',
      [candidate.key, collection.id],
    );

    if (result.rowCount && result.rowCount > 0) {
      if (candidate.priority <= 1) coveredOwn++;
      else coveredDescendant++;
    } else {
      // Something else (a concurrent upload, or a manual set) claimed the cover
      // between the SELECT above and this UPDATE — leave it alone.
      skipped++;
    }
  }

  console.log('--- Cover backfill summary ---');
  console.log(`Coverless collections found: ${coverless.length}`);
  console.log(`Covered from own files:      ${coveredOwn}`);
  console.log(`Covered from a descendant:   ${coveredDescendant}`);
  console.log(`Skipped (claimed elsewhere): ${skipped}`);
  console.log(`No candidate found:          ${noCandidate}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await pool.end();
  process.exitCode = 1;
});
