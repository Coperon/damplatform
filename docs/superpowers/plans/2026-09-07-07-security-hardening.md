# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close remaining prototype holes: share original download, unique token hashes, rate limits on reset/email-change, invite cannot create operators, JWT_SECRET length, CSP SHOULD.

**Architecture:** Spec 07. Work on share routes, rateLimit buckets, invitation CHECK already in DB.

**Tech Stack:** Existing rateLimit.ts, shares.ts, crypto.ts.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Spec: `docs/superpowers/specs/2026-09-07-07-security-perimeter.md`.

---

### Task 1: Share accessLevel for originals

**Files:**
- Modify: `frontend/app/api/share/[token]/file/[resourceId]/route.ts`
- Create: `frontend/server/domain/shares.ts` tests

- [ ] **Step 1: Write test** view-level share + `mode=original` → 403; download-level → 200.

- [ ] **Step 2: Implement gate. Delete Phase 0 characterization that documented the hole.

- [ ] **Step 3: Collection share lists **direct** files only (`eq(resources.collectionId, share.collectionId)`), no descendant CTE.

- [ ] **Step 4: Commit**

```bash
git commit -m "fix: share original requires download access; folder share is direct files"
```

---

### Task 2: Rate limit remaining public POSTs

**Files:**
- Modify: `frontend/lib/rateLimit.ts` (or `server/http/rateLimit.ts`)
- Modify: reset-password, email-change confirm, invite redeem (already), login, forgot

- [ ] **Step 1: Test** helper still fail-open but `console.error` called (spy).

- [ ] **Step 2: Add buckets from Spec 07.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: rate limit reset and email-change confirm"
```

---

### Task 3: Invite role allowlist

**Files:**
- Modify: `frontend/app/api/invitations/route.ts`
- Modify: domain invite

- [ ] **Step 1: Test** body `role: 'operator'` → 400 even for operators using invite API (operators created separately).

- [ ] **Step 2: Implement. Tenant admin may invite tenant_admin/editor/viewer.

- [ ] **Step 3: Commit**

```bash
git commit -m "fix: invitations cannot mint operators"
```

---

### Task 4: Env secret strength

**Files:**
- Modify: `frontend/scripts/check-env.mjs`
- Create: `frontend/server/http/env.ts` used at boot if possible (`instrumentation.ts`)

- [ ] **Step 1: Test** JWT_SECRET length < 32 → throw.

- [ ] **Step 2: Implement. SHARE_TOKEN_KEY must decode to 32 bytes.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: reject weak JWT and share keys at boot"
```

---

### Task 5: Share/invite SHA-256 dual verify

**Files:**
- Modify: `frontend/server/domain/shares.ts`, invitations validate

If hashes look like bcrypt (`$2`), compare bcrypt; else sha256 equality. New tokens sha256.

- [ ] **Step 1: Tests** for both hash shapes.

- [ ] **Step 2: Implement.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: dual-verify share and invite token hashes"
```

---

### Task 6: CSP header SHOULD

**Files:**
- Modify: `frontend/next.config.ts` `headers()`

Add a conservative CSP that allows `'self'` and the S3 endpoint host from env if required for PUT. If S3 PUT is browser-to-MinIO, include that origin.

- [ ] **Step 1: Manual: login, upload, share gallery still work.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: content-security-policy header"
```

---

## Phase 7 done when

- Share view cannot fetch original.
- Operator role not invitable.
- Weak secrets fail boot.
- Folder share is not a subtree.
