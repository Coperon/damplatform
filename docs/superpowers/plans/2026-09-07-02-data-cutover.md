# Data Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform prototype data into the production ownership model without silently dropping multi-grant collections, multi-collection files, or unassigned resources.

**Architecture:** A single append-only SQL migration (Drizzle custom) that **fails the transaction** if the Phase 0 report blockers remain, unless `CUTOVER_ORPHAN_TENANT_ID` is set and the operator accepted the report. Dry-run first on a copy.

**Tech Stack:** PostgreSQL transaction, `frontend/scripts/cutover-report.mjs`, Drizzle custom migration.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Spec: `docs/superpowers/specs/2026-09-07-10-migration-cutover.md`.
- **Do not run on production** until the report is reviewed and a backup exists.

---

### Task 1: Blocker assertions

**Files:**
- Create: `frontend/server/db/cutover/blockers.sql`
- Create: `frontend/server/db/cutover/blockers.test.ts`

**Interfaces:**
- Produces: `assert_cutover_ready()` that RAISE EXCEPTION if:
  - any collection has `COUNT(distinct tenant_id) > 1` on `tenant_collection_access` and env `CUTOVER_ALLOW_MULTI_GRANT` is not `'true'` (default false — **fail**)
  - any resource in >1 collection
  - any non-role-1 user with null tenant_id

Multi-grant **must fail** unless a human wrote a mapping table `cutover_collection_owner(collection_id, tenant_id)` populated before migrate.

- [ ] **Step 1: Write test** using a SQL fixture on TEST DB: two grants on one collection → migration function throws.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement blockers.sql** as a DO block.

- [ ] **Step 4: PASS + commit**

```bash
git add frontend/server/db/cutover/
git commit -m "feat: fail cutover when ownership is ambiguous"
```

---

### Task 2: Mapping tables (human input)

**Files:**
- Create: `frontend/server/db/cutover/mapping.sql`

Tables (temporary, dropped at end of cutover):

```sql
CREATE TABLE cutover_collection_owner (
  collection_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
);
CREATE TABLE cutover_resource_primary_collection (
  resource_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
);
```

Document in `docs/superpowers/specs/2026-09-07-10-migration-cutover.md` runbook: fill these from the report before prod migrate.

- [ ] **Step 1: Script** `frontend/scripts/cutover-suggest-mapping.mjs` that for **single-grant** collections auto-fills `cutover_collection_owner`; leaves multi-grant unfilled.

- [ ] **Step 2: Test** auto-fill for one-grant case; multi-grant omitted.

- [ ] **Step 3: Commit**

```bash
git add frontend/scripts/cutover-suggest-mapping.mjs frontend/server/db/cutover/mapping.sql
git commit -m "feat: suggest 1:1 collection tenant mapping"
```

---

### Task 3: Transform SQL

**Files:**
- Create: `frontend/server/db/migrations/0002_data_cutover.sql` (custom SQL in the Drizzle journal, immediately after the generated production schema). Apply only in a maintenance window after backup. In-place rewrite of the live tables — no `_v2` swap, no dual-write of grant CTEs.

**In-place rewrite (small DB, maintenance window):**

1. Add new columns nullable: `collections.tenant_id`, `resources.tenant_id`, `resources.collection_id`.
2. Fill from mapping.
3. For unassigned resources: insert collection `_orphan_unassigned` in `CUTOVER_ORPHAN_TENANT_ID` and point them there (only if env set; else RAISE).
4. Add NOT NULL + composite FKs.
5. Drop `collection_resource`, `tenant_collection_access`, `tenant_role_permissions`, `roles` FK, convert `users.role_id` → `users.role` enum.
6. Copy global metadata fields per tenant; remap field_data.
7. Shares: set tenant_id from target; unique token_hash (if duplicates, RAISE).
8. Drop old columns/flags.

- [ ] **Step 1: Implement on a restored copy.** Count resources before/after equal.

- [ ] **Step 2: Integration test** with fixture of 2 tenants, 1 grant each, 1 file each → after cutover files owned correctly.

- [ ] **Step 3: Leave `token_hash` values unchanged.** Phase 7 dual-verifies bcrypt and SHA-256. Do not expire live share links in this migration.

- [ ] **Step 4: Commit migration only after copy restore succeeds.**

```bash
git add frontend/server/db/migrations
git commit -m "feat: data cutover to tenant-owned schema"
```

---

### Task 4: Post-cutover verification

**Files:**
- Create: `frontend/scripts/cutover-verify.mjs`

Asserts:

- `resources.tenant_id` is not null
- `resources.collection_id` is not null
- no `collection_resource` table
- operator users have null tenant_id
- row counts match snapshot file written before migrate

- [ ] **Step 1: Write script + test with mock query.**

- [ ] **Step 2: Commit**

```bash
git add frontend/scripts/cutover-verify.mjs
git commit -m "feat: verify cutover invariants"
```

---

## Phase 2 done when

- Copy of production migrated; counts match; zero unmapped multi-grant rows.
- Human signed the report.
- Production migrate has a backup and a window.
- App may be **broken** until Phase 4 DAL if columns changed under old SQL — **therefore Phase 3–4 should land in the same release train as Phase 2** (same PR series, deploy together). If that is not possible, dual-write is required; Spec 10 forbids long dual CTE/tenant_id. **Ship Phase 2+3+4 together.**
