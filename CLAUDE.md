# CLAUDE.md — Project context

## Session workflow

**Start of every session:** read `docs/STATE.md` — the single source of truth
for where the project is right now.

**End of every session:**
1. Rewrite `docs/STATE.md` in place (update; do not append).
2. Prepend one short paragraph to `docs/sessions/CHANGELOG.md`.
3. Do **not** create `session-NNN.md` files.

## What this is

A multi-tenant DAM platform. Files live in object storage; only metadata
lives in Postgres. Clients see only the collections their tenant is granted.

**Portability requirement:** nothing environment-specific is hardcoded.
Database URL, secrets, and storage endpoint all come from configuration, so
the project moves environments with a config change only.

## Architecture

A **single Next.js 16 full-stack app**. The migration off NestJS is complete —
there is no separate backend process, and no Redis/BullMQ or worker in code.

- `frontend/app/api/` — 47 API route handlers (the backend)
- `frontend/app/` — 19 pages (App Router)
- `frontend/lib/` — 20 shared modules (db, auth, session, permissions, storage, i18n, …)
- `frontend/components/` — 9 shared components
- `db/migrations/` — schema, append-only, applied by `frontend/scripts/migrate.mjs`
- `damInfra/` — Docker Compose for Postgres + MinIO

## Hard constraints

- **Raw SQL only** via the `pg` driver — no ORM, no Prisma, ever.
- **Parameterized queries** (`$1`, `$2`) — never concatenate user input.
- Use **bcryptjs**, not `bcrypt` (avoids Windows native-build issues).
- 401 = no/invalid token. 403 = valid token, wrong permission. Never swap.
- 23505 → 409 Conflict. Empty required fields → 400.
- All config from env vars — nothing hardcoded.
- Migrations are append-only; never edit an applied file.

## Auth and roles

Passwords hashed with bcryptjs (10 rounds). Login signs an HS256 JWT
(1 day). Payload: `sub, email, name, canDownload, canUpload, canAdmin,
tenantId, roleId, roleName, canAccessAllTenants, canInvite`.

Roles live in `roles` (1=super_admin, 2=admin, 3=editor, 4=viewer,
5=pending). **Role id 1 is load-bearing** — `lib/session.ts` hardcodes it.
Per-tenant permission overrides live in `tenant_role_permissions` and are
resolved per request by `lib/permissions.ts`.

Guards in `lib/session.ts`: `requireAuth`, `requireAdmin` (role 1 or 2),
`requireSuperAdmin` (role 1 only), and `requirePermission(req, key)` in
`lib/permissions.ts` for per-tenant capability checks.

## Conventions that bite if forgotten

- `ctx.params` in Next.js 16 route handlers is **async** — `const { id } = await ctx.params`.
- `.env.local` is read at startup — restart `npm run dev` after editing.
- Use `jsonwebtoken`, not `jose`.
- Password rule: 8+ chars, upper + lower + digit + special (`validatePasswordStrength` in `lib/users.ts`).
- Route error pattern: lib functions throw `AppError`; handlers catch with
  `if (err instanceof AppError) return Response.json(...)`.
- Upload flow: `POST /api/upload/url` → PUT to the presigned URL →
  `POST /api/upload/complete`. Pass `key` back verbatim.
- Any package resolving a filesystem path at import time (`ffmpeg-static`,
  `pdfjs-dist`, `@napi-rs/canvas`) must be in `serverExternalPackages` in
  `next.config.ts`, or the bundler rewrites the path and `spawn` fails.

See `docs/STATE.md` for the long list of UI/SQL gotchas and current tech debt.

## Known issues (as of 2026-08-18)

These are real and unfixed — do not treat the codebase as clean:

- `GET /api/cover` accepts an arbitrary storage `key` and returns a presigned
  URL for it, gated only by `requireAuth`. Any authenticated user can read any
  object in the bucket. Needs to take a resource/collection id and run the
  tenant access check.
- The recursive tenant access-check CTE is duplicated across ~14 route files
  even though `tenantHasResourceAccess` / `tenantHasCollectionAccess` exist in
  `lib/permissions.ts`. Fix once, in lib — not fourteen times.
- The JWT is stored in `localStorage` and read at ~100 call sites. Should be an
  httpOnly cookie behind `middleware.ts`.
- No rate limiting on login, forgot-password, invite redeem, or share tokens.
- No index on `collections(parent_id)`, which every access check walks.
- No tests and no CI.
