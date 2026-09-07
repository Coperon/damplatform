# Drizzle Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Drizzle, declare the **production** schema in TypeScript, and add a migration that can apply on a **fresh** database (empty) so constraint tests run. Do not drop live prototype tables in production until Phase 2.

**Architecture:** `frontend/server/db/schema.ts` is source of truth. Drizzle Kit generates SQL. Custom SQL migration for generated `search_vector`, trgm GIN, parent-immutability trigger. Existing `0001`/`0002` stay applied on live DBs; this phase uses a separate drizzle journal. Live cutover is Phase 2.

**Tech Stack:** `drizzle-orm`, `drizzle-kit`, `pg`, Vitest, PostgreSQL 18.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase (prototype routes still use `lib/db.ts` until Phase 4–6).
- Spec: `docs/superpowers/specs/2026-09-07-02-database-drizzle.md`.

---

### Task 1: Dependencies and config

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/drizzle.config.ts`
- Create: `frontend/server/db/client.ts`

**Interfaces:**
- Consumes: `DATABASE_URL`, `DIRECT_DATABASE_URL`
- Produces: `getDb()` returning Drizzle instance; `drizzle.config.ts` `out: './server/db/migrations'`

- [ ] **Step 1: Write failing test**

```ts
// frontend/server/db/client.test.ts
import { describe, it, expect } from 'vitest';

describe('db client', () => {
  it('exports getDb', async () => {
    const mod = await import('./client');
    expect(typeof mod.getDb).toBe('function');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run server/db/client.test.ts` — FAIL.

- [ ] **Step 3: Install and implement**

```bash
cd frontend && npm install drizzle-orm && npm install -D drizzle-kit
```

`frontend/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '',
  },
  strict: true,
  verbose: true,
});
```

`frontend/server/db/client.ts`:

```ts
import 'server-only';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const globalForDb = globalThis as unknown as { pool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.pool) {
    globalForDb.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX) || 10,
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) || 10000,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10000,
    });
  }
  return globalForDb.pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}
```

Add `"server-only":` if not present (`npm install server-only`).

- [ ] **Step 4: Run test** — PASS (schema.ts must exist; next task if import fails).

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/drizzle.config.ts frontend/server/db/client.ts frontend/server/db/client.test.ts
git commit -m "chore: add drizzle client and kit config"
```

---

### Task 2: Schema TypeScript

**Files:**
- Create: `frontend/server/db/schema.ts`
- Create: `frontend/server/db/schema.test.ts`

**Interfaces:**
- Produces: tables `tenants`, `users`, `collections`, `resources`, `renditions`, `metadataFields`, `resourceFieldData`, `shares`, `invitations`, `pendingUploads`, `emailTokens`, `auditEvents`, `rateLimitEvents` matching Spec 02 names (camelCase in TS, snake_case in DB via `pgCore`).

- [ ] **Step 1: Write failing tests for invariants expressed in schema objects**

```ts
import { describe, it, expect } from 'vitest';
import { users, collections, resources } from './schema';

describe('schema shape', () => {
  it('users has role and nullable tenantId', () => {
    expect(users.role).toBeDefined();
    expect(users.tenantId).toBeDefined();
  });
  it('resources require collectionId and tenantId', () => {
    expect(resources.collectionId).toBeDefined();
    expect(resources.tenantId).toBeDefined();
  });
  it('collections have parentId', () => {
    expect(collections.parentId).toBeDefined();
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement schema.ts** per Spec 02: `pgEnum`, `uuid`, `text`, `timestamp`, `boolean`, `bigint`, `jsonb`, `unique`, `foreignKey` composite:

```ts
foreignKey({
  columns: [resources.collectionId, resources.tenantId],
  foreignColumns: [collections.id, collections.tenantId],
}).onDelete('cascade')
```

Users CHECK via `check('users_operator_tenant_chk', sql`(role = 'operator' AND tenant_id IS NULL) OR (role IN ('tenant_admin','editor','viewer') AND tenant_id IS NOT NULL)`)`.

Collections: unique on `(id, tenantId)`; parent composite FK CASCADE; check `parent_id IS DISTINCT FROM id`.

Shares: unique `tokenHash`; check one target.

Invitations: check role in tenant roles; unique `tokenHash`.

Do **not** declare `searchVector` as a writable column; add a comment and custom SQL in Task 3.

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Generate migration (dry)**

Run: `cd frontend && npx drizzle-kit generate --name production_schema`

Expected: SQL files under `frontend/server/db/migrations/`.

- [ ] **Step 6: Commit**

```bash
git add frontend/server/db/schema.ts frontend/server/db/schema.test.ts frontend/server/db/migrations
git commit -m "feat: declare production drizzle schema"
```

---

### Task 3: Custom SQL extras

**Files:**
- Create: next custom migration SQL in `frontend/server/db/migrations/` (handwritten file after generated one, same journal)
- Create: `frontend/server/db/extras.md` listing extras so they are not re-declared in schema.ts

Custom SQL must:

1. `CREATE EXTENSION IF NOT EXISTS pg_trgm;` `pgcrypto` if needed.
2. Generated column `search_vector` on `resources` if not in Drizzle generate.
3. GIN indexes.
4. Trigger: `BEFORE UPDATE ON collections` — `IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN RAISE EXCEPTION 'parent_id is immutable'`.
5. `touch_updated_at` on resources.

- [ ] **Step 1: Write an integration test** (skip if no `TEST_DATABASE_URL`):

```ts
it('rejects collection parent_id update', async () => {
  // insert tenant, two collections, UPDATE parent_id, expect throw
});
```

- [ ] **Step 2: Apply on empty test DB** `npx drizzle-kit migrate` with `TEST_DATABASE_URL`.

- [ ] **Step 3: Commit extras + tests.**

---

### Task 4: Constraint integration tests

**Files:**
- Create: `frontend/server/db/invariants.int.test.ts`

Tests (Postgres):

1. Insert operator with `tenant_id` set → fail CHECK.
2. Insert editor with `tenant_id` null → fail CHECK.
3. Insert resource with collection from other tenant → fail composite FK.
4. Insert collection `parent_id = id` → fail CHECK.
5. Tenant DELETE while user exists → fail RESTRICT.

- [ ] **Step 1: Write tests.** Run — FAIL until migrate on test DB.

- [ ] **Step 2: Implement only if schema missing constraints.**

- [ ] **Step 3: Commit.**

```bash
git add frontend/server/db/invariants.int.test.ts
git commit -m "test: production schema invariants on postgres"
```

---

## Phase 1 done when

- Fresh DB can apply Drizzle migrations.
- Live prototype still uses old `db/migrations` and `lib/db.ts`.
- Schema matches Spec 02; extras documented.
- **Do not** run this migration on production until Phase 2 mapping is approved.
