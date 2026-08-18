// OBSOLETE — its job is done and it can no longer run. This was the Stage 1
// multi-tenancy backfill, a one-time tool that read group_id/group_collection_access
// (the legacy group system, retired in Stage 94 — see docs/STATE.md) as its
// migration source. Both are now dropped from the schema, so any run past
// this point fails immediately on the first query. Left in place as a
// historical record of how the companies/roles backfill was derived, not as
// a runnable script. Do not attempt to fix or re-run it.
//
// Stage 1 multi-tenancy backfill. Purely additive — populates the new
// companies / roles / company_collection_access tables and the new
// users.company_id / users.role_id columns from the existing group-based
// data. Nothing in the app reads these new columns yet; this script only
// prepares them for a later cutover stage.
//
// What it does, in order:
//   1. Verifies the 5 roles (seeded by the Stage 1 DDL) are present.
//   2. Finds or creates a single "Test Company" row.
//   3. Maps every user's group_id to a role_id:
//        1 Administrators -> 1 super_admin
//        2 Editors        -> 3 editor
//        3 Viewers        -> 4 viewer
//        4 Pending         -> 5 pending
//      (role 2 "admin" is never assigned here — company admins arrive only
//      via invitation, a later stage.)
//   4. Sets company_id: NULL for super admins (former Administrators), the
//      Test Company id for everyone else.
//   5. Copies group_collection_access grants into company_collection_access,
//      deduped, all pointing at Test Company.
//
// Idempotent: every write is guarded (role_id/company_id only set where
// still NULL; the grants insert is ON CONFLICT DO NOTHING), so re-running
// finds nothing left to do. Not run automatically — invoke manually:
//
//   node scripts/migrate-to-companies.mjs

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

const TEST_COMPANY_NAME = 'Test Company';

// group_id -> role_id, per the approved design's mapping.
const GROUP_TO_ROLE = {
  1: 1, // Administrators -> super_admin
  2: 3, // Editors        -> editor
  3: 4, // Viewers        -> viewer
  4: 5, // Pending         -> pending
};

async function ensureRolesSeeded() {
  const { rows } = await pool.query('SELECT id, name FROM roles ORDER BY id');
  if (rows.length !== 5) {
    throw new Error(
      `Expected 5 seeded roles, found ${rows.length}. Run the Stage 1 DDL (roles seed) before this script.`,
    );
  }
  return rows;
}

async function findOrCreateTestCompany() {
  const existing = await pool.query('SELECT id FROM companies WHERE name = $1', [TEST_COMPANY_NAME]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await pool.query(
    'INSERT INTO companies (name) VALUES ($1) RETURNING id',
    [TEST_COMPANY_NAME],
  );
  return inserted.rows[0].id;
}

async function backfillRoleIds() {
  const counts = {};
  for (const [groupId, roleId] of Object.entries(GROUP_TO_ROLE)) {
    const result = await pool.query(
      'UPDATE users SET role_id = $1 WHERE group_id = $2 AND role_id IS NULL',
      [roleId, Number(groupId)],
    );
    counts[groupId] = result.rowCount ?? 0;
  }
  return counts;
}

async function backfillCompanyIds(testCompanyId) {
  // Former Administrators (now super_admin, role 1) keep company_id NULL —
  // untouched, since the column already defaults to NULL. Everyone else gets
  // Test Company, only where not already set.
  const result = await pool.query(
    `UPDATE users SET company_id = $1
     WHERE role_id IS DISTINCT FROM 1 AND company_id IS NULL`,
    [testCompanyId],
  );
  return result.rowCount ?? 0;
}

async function backfillCompanyCollectionAccess(testCompanyId) {
  const result = await pool.query(
    `INSERT INTO company_collection_access (company_id, collection_id)
     SELECT DISTINCT $1::uuid, collection_id FROM group_collection_access
     ON CONFLICT DO NOTHING`,
    [testCompanyId],
  );
  return result.rowCount ?? 0;
}

async function main() {
  const roles = await ensureRolesSeeded();
  const testCompanyId = await findOrCreateTestCompany();
  const roleUpdateCounts = await backfillRoleIds();
  const companyUpdateCount = await backfillCompanyIds(testCompanyId);
  const grantsInsertedCount = await backfillCompanyCollectionAccess(testCompanyId);

  const { rows: roleCounts } = await pool.query(
    `SELECT r.id, r.name, COUNT(u.id) AS user_count
     FROM roles r
     LEFT JOIN users u ON u.role_id = r.id
     GROUP BY r.id, r.name
     ORDER BY r.id`,
  );
  const { rows: companyCounts } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE company_id IS NULL) AS no_company,
       COUNT(*) FILTER (WHERE company_id = $1) AS test_company,
       COUNT(*) FILTER (WHERE role_id IS NULL) AS no_role
     FROM users`,
    [testCompanyId],
  );
  const { rows: grantCounts } = await pool.query(
    `SELECT
       (SELECT COUNT(DISTINCT collection_id) FROM group_collection_access) AS old_distinct_collections,
       (SELECT COUNT(*) FROM company_collection_access WHERE company_id = $1) AS new_grant_rows`,
    [testCompanyId],
  );

  console.log('--- Multi-tenancy backfill summary ---');
  console.log(`Roles seeded: ${roles.map((r) => `${r.id}=${r.name}`).join(', ')}`);
  console.log(`Test Company id: ${testCompanyId}`);
  console.log(`role_id newly set this run, by group_id: ${JSON.stringify(roleUpdateCounts)}`);
  console.log(`company_id newly set this run: ${companyUpdateCount}`);
  console.log(`company_collection_access rows newly inserted this run: ${grantsInsertedCount}`);
  console.log('');
  console.log('Users by role (all time, not just this run):');
  for (const row of roleCounts) {
    console.log(`  ${row.name} (role ${row.id}): ${row.user_count}`);
  }
  console.log('');
  console.log(
    `Users with company_id IS NULL: ${companyCounts[0].no_company}  |  ` +
      `Users with Test Company: ${companyCounts[0].test_company}  |  ` +
      `Users with role_id IS NULL: ${companyCounts[0].no_role}`,
  );
  console.log(
    `group_collection_access distinct collections: ${grantCounts[0].old_distinct_collections}  |  ` +
      `company_collection_access rows (Test Company): ${grantCounts[0].new_grant_rows}`,
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await pool.end();
  process.exitCode = 1;
});
