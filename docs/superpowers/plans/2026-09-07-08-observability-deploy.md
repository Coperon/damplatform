# Observability and Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Structured request logs, health, CI build, Compose without Redis, migrate path for Drizzle, optional Sentry, pending-upload cleanup script.

**Architecture:** Spec 08.

**Tech Stack:** Next.js instrumentation, GitHub Actions, Docker Compose, drizzle-kit.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Spec: `docs/superpowers/specs/2026-09-07-08-observability-ops.md`.

---

### Task 1: Request id + JSON log helper

**Files:**
- Create: `frontend/server/http/log.ts`
- Create: `frontend/server/http/log.test.ts`
- Modify: `frontend/server/http/withAuth.ts` to log method, path, status, userId, tenantId

Do not add pino unless you want it; `JSON.stringify` to stdout is enough.

- [ ] **Step 1: Test** log line is JSON with `requestId`.

- [ ] **Step 2: Implement. Redact cookies.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: structured request logs with request id"
```

---

### Task 2: Health deep check

**Files:**
- Modify: `frontend/app/api/health/route.ts`

Keep `SELECT 1`. Add optional S3 `HeadBucket` when `HEALTH_CHECK_STORAGE=1`.

- [ ] **Step 1: Test** DB failure → 503.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: health check remains fail-closed on database"
```

---

### Task 3: CI build

**Files:**
- Modify: `.github/workflows/ci.yml`

Add `npm run build` after tests. Integration job with Postgres service when feasible (`postgres:18`, `TEST_DATABASE_URL`).

- [ ] **Step 1: Ensure build does not require live S3 (mock env in CI).

- [ ] **Step 2: Commit**

```bash
git commit -m "ci: typecheck, test, and next build"
```

---

### Task 4: Remove Redis from Compose

**Files:**
- Modify: `damInfra/docker-compose.yml`
- Modify: `README.md` layout table (user asked for production; README is the runbook — update Redis line)

- [ ] **Step 1: Remove redis service and any depends_on.

- [ ] **Step 2: Commit**

```bash
git commit -m "chore: drop unused redis from local infra"
```

---

### Task 5: Drizzle migrate in deploy docs + script

**Files:**
- Create: `frontend/scripts/migrate-drizzle.mjs` wrapping `drizzle-kit migrate` with `DIRECT_DATABASE_URL`
- Modify: `README.md` migrations section
- Modify: `frontend/package.json` `"db:migrate": "node scripts/migrate-drizzle.mjs"`

Keep old `migrate.mjs` for 0001/0002 on virgin DBs: virgin install applies historical SQL **or** only Drizzle if journal includes baseline. **Decision:** new environments apply Drizzle journal only if it contains full production schema; old `db/migrations` remain for existing deploys already applied. Document both.

- [ ] **Step 1: Script exits 1 if no DIRECT_DATABASE_URL/DATABASE_URL.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: drizzle migrate wrapper using direct database url"
```

---

### Task 6: Cleanup pending uploads

**Files:**
- Create: `frontend/scripts/cleanup-pending-uploads.mjs`
- Create: `frontend/app/api/internal/cron/cleanup/route.ts` guarded by `CRON_SECRET` header

- [ ] **Step 1: Test** expired unconsumed rows deleted; consumed kept.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: expire unused pending uploads"
```

---

### Task 7: Sentry SHOULD

**Files:**
- Modify: `frontend/package.json` if adding `@sentry/nextjs`
- Create: `frontend/sentry.*.config.ts` only if DSN present

Skip code if team defers; add README checkbox. If implementing: init from `SENTRY_DSN`, no tokens in breadcrumbs.

- [ ] **Step 1: Behind env. App runs without DSN.

- [ ] **Step 2: Commit or document skip in README production checklist.

---

## Phase 8 done when

- CI runs `next build`.
- Redis gone from Compose.
- Logs are JSON.
- Cleanup script exists.
- README describes PITR + migrate order (migrate then deploy).
