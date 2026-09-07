# Characterization Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock what the prototype actually does today (isolation CTEs, login status, unassigned files, M2M, share original) so the cutover cannot silently invent or destroy behavior.

**Architecture:** Add Vitest integration/unit tests against the **current** `pg` helpers and auth functions. Do not change product behavior in this phase. These tests will be deleted or rewritten after Spec 01–03 land.

**Tech Stack:** Vitest, existing `frontend/lib/permissions.ts`, `frontend/lib/auth.ts`, `frontend/lib/session.ts`, Postgres only if `TEST_DATABASE_URL` is set.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth (not introduced in this phase).
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Specs: `docs/superpowers/specs/2026-09-07-00-index.md`, `2026-09-07-09-testing.md`, `2026-09-07-10-migration-cutover.md`.

---

### Task 1: Cutover inventory script (read-only)

**Files:**
- Create: `frontend/scripts/cutover-report.mjs`
- Test: `frontend/scripts/cutover-report.test.ts`

**Interfaces:**
- Consumes: `DATABASE_URL` or `DIRECT_DATABASE_URL`; current tables `tenant_collection_access`, `collection_resource`, `users`, `collections`, `resources`, `shares`
- Produces: JSON printed to stdout with counts: `unassignedResources`, `multiCollectionResources`, `multiTenantGrantedCollections`, `usersMissingTenant`, `role2CrossTenant`, `globalMetadataFields`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildCutoverReport } from './cutover-report.mjs';

describe('buildCutoverReport', () => {
  it('returns the expected keys', async () => {
    const report = await buildCutoverReport({
      query: async (sql: string) => {
        if (sql.includes('collection_resource')) return { rows: [{ n: 3 }] };
        return { rows: [{ n: 0 }] };
      },
    });
    expect(report).toHaveProperty('unassignedResources');
    expect(report).toHaveProperty('multiCollectionResources');
    expect(report).toHaveProperty('multiTenantGrantedCollections');
  });
});
```

Vitest cannot import `.mjs` named exports unless the script exports them. Export `buildCutoverReport` from the script.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run scripts/cutover-report.test.ts`

Expected: FAIL (module or function not found).

- [ ] **Step 3: Write minimal implementation**

Implement `buildCutoverReport({ query })` running COUNT queries:

- Unassigned: `SELECT COUNT(*) FROM resources r WHERE NOT EXISTS (SELECT 1 FROM collection_resource cr WHERE cr.resource_id = r.id)`
- Multi-collection: `SELECT COUNT(*) FROM (SELECT resource_id FROM collection_resource GROUP BY resource_id HAVING COUNT(*) > 1) s`
- Multi-tenant grants: `SELECT COUNT(*) FROM (SELECT collection_id FROM tenant_collection_access GROUP BY collection_id HAVING COUNT(*) > 1) s`
- Users missing tenant: `SELECT COUNT(*) FROM users WHERE tenant_id IS NULL AND role_id <> 1`
- Role2 cross-tenant: `SELECT COUNT(*) FROM users WHERE role_id = 2 AND can_access_all_tenants`
- Global metadata: `SELECT COUNT(*) FROM metadata_fields WHERE tenant_id IS NULL`

CLI `node scripts/cutover-report.mjs` uses `pg` Pool when not in test.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run scripts/cutover-report.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts/cutover-report.mjs frontend/scripts/cutover-report.test.ts
git commit -m "test: add read-only cutover inventory report"
```

---

### Task 2: Document current login status gap

**Files:**
- Modify: `frontend/lib/session.test.ts`
- Modify: `frontend/lib/auth.ts` only if exporting a test seam; prefer testing `login` with a mocked `findByEmail`

**Interfaces:**
- Consumes: `login()` current behavior
- Produces: a test named `login does not check users.status` that **asserts today's bug** so Phase 3 must invert it

- [ ] **Step 1: Write characterization test**

If `login` cannot be unit-tested without DB, extract nothing yet. Add:

```ts
it('characterization: login() does not read user.status (prototype gap)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf8');
  expect(src).toMatch(/bcrypt\.compare/);
  expect(src).not.toMatch(/status/);
});
```

This is a source characterization, not a behavior freeze we want to keep.

- [ ] **Step 2: Run** `npx vitest run lib/session.test.ts` — expect PASS (or FAIL if status already appears; then update assertion).

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/session.test.ts
git commit -m "test: characterize login ignoring users.status"
```

---

### Task 3: Characterize share original gate

**Files:**
- Modify: `frontend/app/api/share/[token]/file/[resourceId]/route.ts` (read only)
- Create: `frontend/app/api/share/share-file-auth.test.ts`

- [ ] **Step 1: Write a source/characterization test** that `mode=original` for images is not gated on `accessLevel === 'download'` (current fact from security review). If the file already gates it, skip and note in report.

- [ ] **Step 2: Run vitest.** Expected: PASS documenting the gap.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/api/share/share-file-auth.test.ts
git commit -m "test: characterize share original download gate"
```

---

## Phase 0 done when

- `node frontend/scripts/cutover-report.mjs` runs against a DB and prints JSON.
- Characterization tests are in CI.
- No product behavior changed.
