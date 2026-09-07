# API and UI Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route handlers become thin HTTP adapters; remaining SQL leaves `app/api`; UI uses “tenant” copy; `withAuth` wraps protected routes; add Zod at the edge.

**Architecture:** `frontend/server/http/withAuth.ts`, `frontend/server/http/errors.ts`, domain functions from Phases 3–5. Split fat pages only when a feature is already being touched.

**Tech Stack:** Zod, Next.js route handlers, existing React pages.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Spec: `docs/superpowers/specs/2026-09-07-05-server-architecture.md`.

---

### Task 1: withAuth and error mapper

**Files:**
- Create: `frontend/server/http/withAuth.ts`
- Create: `frontend/server/http/handle.ts`
- Create: `frontend/server/http/withAuth.test.ts`

**Interfaces:**

```ts
export function withAuth(
  handler: (req: Request, ctx: { principal: Principal; params: Record<string, string> }) => Promise<Response>,
): (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

export function handleError(err: unknown, requestId: string): Response;
```

- [ ] **Step 1: Test** unauthenticated → 401; AppError 409 → JSON message; unknown → 500 without stack.

- [ ] **Step 2: Implement using `requireAuth` from server/auth.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: withAuth wrapper and error mapper"
```

---

### Task 2: Zod DTOs for mutating routes

**Files:**
- Create: `frontend/server/http/dtos.ts`
- Modify: invitations, shares, collections POST, users PATCH

Install `zod`. Each POST/PATCH parses with `safeParse`; 400 on failure.

- [ ] **Step 1: Test** collection create `{ name: '' }` → 400.

- [ ] **Step 2: Apply to remaining mutating routes (grep `await request.json()`).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: zod validation at HTTP boundary"
```

---

### Task 3: Finish route SQL extraction

**Files:**
- Modify: remaining fat routes: `activity`, `analytics`, `tenants/[id]`, `upload/from-url`, `users/[id]`, `metadata-fields`

Move SQL into `server/dal` / `server/domain`. Tenant delete: RESTRICT semantics (count users/resources/collections, 409 if not empty). Remove exclusivity CTE.

- [ ] **Step 1: Test** tenant delete with a user → 409.

- [ ] **Step 2: Implement drain-only delete.

- [ ] **Step 3: `rg "db.query" frontend/app/api` should be empty (or only health).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: move remaining API SQL into server domain"
```

---

### Task 4: UI copy and access editor removal

**Files:**
- Modify: `frontend/locales/en.json`, `frontend/locales/it.json`
- Modify: collection access UI (`tenant_collection_access` editor) — **remove** Access modal that grants tenants onto folders (product gone).
- Modify: `AppShell` nav `companies` → `tenants`

- [ ] **Step 1: Grep `companies` / `Company` in UI; replace user-facing strings.

- [ ] **Step 2: Delete access-editor client flows; DELETE/PUT `/api/collections/[id]/access` return 410 or remove route.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: tenant-owned UI; remove cross-tenant folder grants"
```

---

### Task 5: Targeted page splits

**Files:**
- Modify: `frontend/app/collections/[id]/page.tsx` only extract a component if this phase already touches it (upload/move). Do not rewrite 2800 lines for style.

- [ ] **Step 1: If adding move UI, put it in `components/MoveFileDialog.tsx`.

- [ ] **Step 2: Commit with the feature, not a drive-by split.

---

## Phase 6 done when

- No `db.query` in `app/api` except health if still using pool ping.
- Grant UI gone.
- withAuth used on protected routes.
