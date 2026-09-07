# Authorization and DAL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace recursive grant CTEs with tenant-scoped Drizzle DAL and a static role policy map. Fail closed.

**Architecture:** `frontend/server/authorization/policies.ts` + `frontend/server/dal/*.ts`. Route handlers switch to domain functions that call DAL with `Principal`. Delete `tenantHasResourceAccess` CTE after all call sites moved.

**Tech Stack:** Drizzle, Vitest, Spec 01 matrix.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Specs: `2026-09-07-03-authorization.md`, `2026-09-07-05-server-architecture.md`.

---

### Task 1: Policy map

**Files:**
- Create: `frontend/server/authorization/policies.ts`
- Create: `frontend/server/authorization/policies.test.ts`

**Interfaces:**

```ts
export type Action =
  | 'collection.create' | 'collection.rename' | 'collection.delete'
  | 'resource.upload' | 'resource.move' | 'resource.delete' | 'resource.edit_metadata' | 'resource.download'
  | 'share.create' | 'share.revoke'
  | 'user.invite' | 'user.manage'
  | 'tenant.create' | 'tenant.delete';

export function can(principal: Principal, action: Action): boolean;
export function libraryTenantId(principal: Principal): string | null;
```

`libraryTenantId`: user → `tenantId`; operator → `actingTenantId`; share → `tenantId`.

- [ ] **Step 1: Encode Spec 01 table as tests** (viewer cannot upload; editor cannot share.create; tenant_admin cannot tenant.create; operator can all library actions).

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement static Record<role, Set<Action>>.** Operator: all actions. Viewer: `resource.download` only among mutations (plus implicit view which is not an action — view is “passed auth + tenant scope”).

- [ ] **Step 4: PASS + commit**

```bash
git add frontend/server/authorization/
git commit -m "feat: static role permission map"
```

---

### Task 2: DAL finders

**Files:**
- Create: `frontend/server/dal/resources.ts`
- Create: `frontend/server/dal/collections.ts`
- Create: `frontend/server/dal/resources.test.ts` (integration)

**Interfaces:**

```ts
export async function getResource(tenantId: string, id: string): Promise<ResourceRow | null>;
export async function listCollectionFiles(tenantId: string, collectionId: string): Promise<ResourceRow[]>;
export async function getCollection(tenantId: string, id: string): Promise<CollectionRow | null>;
```

Every query `eq(resources.tenantId, tenantId)`.

- [ ] **Step 1: Integration test** insert T1 and T2 resources; `getResource(T1, t2id)` returns null.

- [ ] **Step 2: Implement.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: tenant-scoped resource and collection DAL"
```

---

### Task 3: Domain wrappers + route migration (critical routes first)

**Files:**
- Create: `frontend/server/domain/resources.ts`
- Modify: `frontend/app/api/download/[id]/route.ts`
- Modify: `frontend/app/api/resources/[id]/route.ts`
- Modify: `frontend/app/api/collections/route.ts`
- Modify: `frontend/app/api/collections/[id]/route.ts`
- Modify: `frontend/app/api/search/route.ts`
- Modify: `frontend/app/api/media/route.ts`

**Interfaces:**

```ts
export async function downloadResource(principal: Principal, id: string): Promise<{ url: string }>;
```

Throws AppError 401/403/404. 404 when DAL returns null (no cross-tenant existence leak).

- [ ] **Step 1: HTTP/unit test download as T1 of T2 id → 404.

- [ ] **Step 2: Wire requireAuth → principal → domain.

- [ ] **Step 3: Repeat for search/media: **must** filter `tenantId`. Operator requires acting tenant.

- [ ] **Step 4: Commit per route group.**

```bash
git commit -m "feat: tenant-scoped download and library reads"
```

---

### Task 4: Delete CTE helpers

**Files:**
- Modify: `frontend/lib/permissions.ts` — remove `tenantHasResourceAccess` recursive SQL once grep is clean
- Delete unused `sqlAccessibleCollectionsCte`

- [ ] **Step 1: `rg tenantHasResourceAccess frontend` empty except git history.

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor: remove grant-graph access CTEs"
```

---

### Task 5: Isolation matrix CI

**Files:**
- Create: `frontend/server/authorization/isolation.int.test.ts`

Fixture: two tenants, viewer each, operator. Tests from Spec 09.

- [ ] **Step 1: Write full matrix.

- [ ] **Step 2: Run against TEST_DATABASE_URL.

- [ ] **Step 3: Commit**

```bash
git commit -m "test: tenant isolation matrix"
```

---

## Phase 4 done when

- No recursive access CTE in runtime path.
- Isolation matrix green.
- Operators cannot list files without acting tenant.
