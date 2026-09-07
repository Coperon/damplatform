# Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JWT identifies `sub` only; every request loads the user row; login refuses non-active users; operator acting tenant is set via httpOnly API.

**Architecture:** Replace `frontend/lib/session.ts` capability JWT with `frontend/server/auth/*`. Keep cookie name `dam_session`.

**Tech Stack:** jsonwebtoken, bcryptjs, Drizzle or existing `pg` until Phase 4 — **use Drizzle user select if Phase 2 already applied; else still pg**. Coordinate with Phase 2 release.

## Global Constraints

- Single Next.js 16 full-stack app. No NestJS, no Redis, no job queue in this program.
- Drizzle schema is the only table/column/constraint source of truth.
- Raw SQL only for tsvector / pg_trgm / triggers / subtree SQL / one-time cutover.
- bcryptjs for passwords, not bcrypt. jsonwebtoken HS256, not jose.
- Parameterized queries only. 401 = unauthenticated, 403 = authenticated but forbidden.
- Fail closed on authorization. Empty required fields → 400. Unique violations → 409.
- All config from environment. Migrations append-only; never edit an applied file.
- App stays runnable after each phase.
- Spec: `docs/superpowers/specs/2026-09-07-04-authentication.md`.

---

### Task 1: Identity JWT + loadUser

**Files:**
- Create: `frontend/server/auth/jwt.ts`
- Create: `frontend/server/auth/principal.ts`
- Create: `frontend/server/auth/principal.test.ts`
- Modify: `frontend/lib/session.ts` to re-export from server until call sites move (or update call sites in this task)

**Interfaces:**
- Consumes: `readSessionToken(request)`
- Produces:

```ts
export function mintSessionToken(userId: string): string;
export async function requireAuth(request: Request): Promise<Principal | Response>;
export async function loadUserById(id: string): Promise<UserRow | null>;
```

`Principal` from Spec 03. Client users have `tenantId: string`. Operators have `actingTenantId` from cookie `dam_acting_tenant` only if httpOnly set later; for this task read cookie but do not trust it for non-operators.

- [ ] **Step 1: Write failing tests**

```ts
it('ignores role claim in jwt payload', async () => {
  const token = jwt.sign({ sub: userId, role: 'operator' }, secret, { algorithm: 'HS256' });
  // loadUser returns editor → principal.role === 'editor'
});

it('returns 401 when status is disabled', async () => {
  // user status disabled
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement mint with `{ sub }` only; verify HS256; load user; if !user || status !== 'active' return 401.**

Invert Phase 0 characterization: `auth.ts` **must** check status. Update characterization test to the new rule (delete the “does not read status” test).

- [ ] **Step 4: PASS.**

- [ ] **Step 5: Commit**

```bash
git add frontend/server/auth frontend/lib/session.ts frontend/lib/auth.ts frontend/lib/session.test.ts
git commit -m "feat: load user row on every request; ignore jwt capabilities"
```

---

### Task 2: Login status and audit

**Files:**
- Modify: `frontend/lib/auth.ts` or `frontend/server/auth/login.ts`
- Modify: `frontend/app/api/auth/login/route.ts`

- [ ] **Step 1: Test** `login` with disabled user → generic failure, no cookie.

- [ ] **Step 2: Implement status check after bcrypt (same generic error as bad password).**

- [ ] **Step 3: Audit `login_success` / `login_failure` (may write to old `access_log` until `audit_events` exists; if Phase 2 created `audit_events`, use it).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: reject inactive users on login"
```

---

### Task 3: Operator acting-tenant API

**Files:**
- Create: `frontend/app/api/auth/acting-tenant/route.ts`
- Modify: `frontend/components/AppShell.tsx` to POST instead of `document.cookie`

**Interfaces:**
- `POST { tenantId: uuid }` operator only; Set-Cookie `dam_acting_tenant` httpOnly SameSite=Lax.
- `DELETE` clears cookie.

- [ ] **Step 1: Test** non-operator POST → 403; operator with unknown tenant → 404; success sets cookie.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Remove JS cookie writes for `dam_acting_tenant`.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: httpOnly acting tenant cookie for operators"
```

---

### Task 4: Password reset tokens SHA-256 lookup

**Files:**
- Modify: `frontend/lib/auth.ts`, `frontend/lib/emailChange.ts`
- Leave invite/share bcrypt dual-verify if cutover did not rehash (Phase 7 finishes).

- [ ] **Step 1: Test** reset token stored as sha256 hex; consume once.

- [ ] **Step 2: Implement `hashToken(raw)` sha256; lookup by hash.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: store email tokens as sha256 hashes"
```

---

## Phase 3 done when

- Forged JWT role claims cannot escalate.
- Disabled users cannot use old cookies.
- Acting tenant not writable from JS.
