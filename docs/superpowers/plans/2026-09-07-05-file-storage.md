# File Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-issued storage keys, pending_uploads binding, HeadObject on complete, subtree delete deletes objects after DB commit.

**Architecture:** `frontend/server/storage/keys.ts` + `frontend/server/domain/uploads.ts`. Old `uploads/` keys remain readable. New objects use `tenants/{tenantId}/resources/{resourceId}/original`.

**Tech Stack:** AWS SDK S3, Drizzle `pending_uploads`, existing `lib/storage.ts` moved to `server/storage/s3.ts`.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Spec: `docs/superpowers/specs/2026-09-07-06-file-storage.md`.

---

### Task 1: Key builder

**Files:**
- Create: `frontend/server/storage/keys.ts`
- Create: `frontend/server/storage/keys.test.ts`

**Interfaces:**

```ts
export function originalKey(tenantId: string, resourceId: string): string;
export function renditionKey(tenantId: string, resourceId: string, kind: 'thumbnail' | 'preview'): string;
```

Returns `tenants/${tenantId}/resources/${resourceId}/original` etc. Reject non-uuid inputs.

- [ ] **Step 1: Tests** for format and rejection of `../`.

- [ ] **Step 2: Implement.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: server-generated object storage keys"
```

---

### Task 2: pending_uploads presign

**Files:**
- Modify: `frontend/app/api/upload/url/route.ts`
- Create: `frontend/server/domain/uploads.ts`

**Interfaces:**

```ts
export async function createPendingUpload(
  principal: Principal,
  input: { collectionId: string; filename: string; mimeType: string; sizeBytes: number },
): Promise<{ pendingId: string; uploadUrl: string; key: string }>;
```

Allocate `resourceId = randomUUID()`, insert pending row, presign PUT for `originalKey(tenantId, resourceId)`.

- [ ] **Step 1: Test** editor without collection → 400; other tenant collection → 404; success inserts pending.

- [ ] **Step 2: Implement + require `resource.upload`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: bind presigned uploads to pending_uploads"
```

---

### Task 3: complete rejects forged keys

**Files:**
- Modify: `frontend/app/api/upload/complete/route.ts`

**Interfaces:**

```ts
export async function completeUpload(principal: Principal, pendingId: string): Promise<ResourceRow>;
```

Load pending by id + user id + consumedAt is null + expiresAt > now. HeadObject. Insert resource with same id as in key. Mark consumed.

- [ ] **Step 1: Test** complete `{ key: 'uploads/evil' }` without pendingId → 400. complete other user’s pendingId → 403.

- [ ] **Step 2: Remove persisting `body.key`.

- [ ] **Step 3: Commit**

```bash
git commit -m "fix: upload complete only consumes server pending rows"
```

---

### Task 4: Move file

**Files:**
- Create: `frontend/server/domain/resources.ts` `moveResource`
- Modify: collection file routes as needed

- [ ] **Step 1: Test** move to other tenant collection 404; duplicate filename 409; viewer 403.

- [ ] **Step 2: Update `collection_id` only; storage key unchanged.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: move file between collections in tenant"
```

---

### Task 5: Destructive collection delete + S3

**Files:**
- Create: `frontend/server/domain/collections.ts` `deleteCollectionSubtree`
- Modify: `frontend/app/api/collections/[id]/route.ts` DELETE

SQL downward CTE for descendant ids (hierarchy, not access). Select storage keys. Delete collection row. Then deleteObject each key.

- [ ] **Step 1: Test** with mock storage: child file key passed to deleteObject.

- [ ] **Step 2: Implement transaction then S3.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: collection delete destroys subtree and objects"
```

---

## Phase 5 done when

- Forged complete keys fail.
- New keys use tenant/resource layout.
- Folder delete removes objects (mocked in CI).
