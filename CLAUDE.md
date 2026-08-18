# CLAUDE.md — Project context

## Session context

**At the start of every session:** read `docs/STATE.md` — it is the single source of truth for where the project is right now.

**At the end of every session:**
1. Rewrite `docs/STATE.md` in place (update current state, do not append).
2. Prepend one short paragraph to `docs/sessions/CHANGELOG.md` (date + theme + what shipped).
3. Do **not** create `session-NNN.md` files. If you need to preserve a full transcript, move it to `docs/sessions/archive/`.

See `docs/sessions/README.md` for the full workflow.

---

Context for an AI assistant (or a new developer) working on this project.
Read `docs/STATE.md` for current state; the rest of this file is background reference.

## What this project is

A custom **Digital Asset Management (DAM)** platform, built from scratch,
inspired by ResourceSpace's architecture but on a modern stack. It is a
multi-client system: Coperon uploads assets (images, video, audio, PDFs), and
clients log in to access only the assets shared with their group.

**Core principle:** the actual files live in object storage; only the metadata
lives in the database.

**Portability requirement (important):** nothing environment-specific is
hardcoded — everything (database URL, secrets, storage endpoint) lives in
configuration, so the project can move from localhost to a server with only a
config change.

## Stack

- **Frontend:** Next.js — *not started yet*.
- **Backend:** NestJS — *in progress*. Runs on `http://localhost:3000`.
- **Database:** PostgreSQL 18, accessed with **raw SQL via the `pg` driver**
  (no ORM, no Prisma — deliberate team decision).
- **Queue:** Redis 7 + BullMQ — running, *not used in code yet*.
- **Object storage:** MinIO (S3-compatible) for local dev — running, *not used
  in code yet*. Provider for production is deferred; code stays S3-portable.
- **Worker:** a separate process for thumbnails/previews — *not started yet*.

## How to run / resume

1. Start **Docker Desktop**, wait for "Engine running".
2. In `damInfra/`: `docker compose start` then `docker compose ps`
   (expect `dam_postgres`, `dam_redis`, `dam_minio` all "Up").
3. In `backend/`: `npm run start:dev` (expect "Found 0 errors" and routes mapped).
4. Test endpoints with PowerShell `Invoke-RestMethod`.

To stop: `docker compose stop` in `damInfra/`, Ctrl+C in the backend terminal.
Use `docker compose stop` (pauses, keeps data), **never** `down -v` (deletes data).

## Folder layout

- `damplatform/backend/` — the NestJS backend (the only code so far).
- `damplatform/backend/.env` — holds `DATABASE_URL` and `JWT_SECRET` (never committed).
- `damInfra/` — `docker-compose.yml`, the DB schema (`dam_schema_full.sql`),
  and the Docker `.env` (Postgres + MinIO credentials).

## Backend files (`backend/src/`)

- `main.ts` — entry point (default NestJS).
- `app.module.ts` — wires everything: global `ConfigModule`, `JwtModule`
  (registered with `registerAsync` + `ConfigService`), and all providers.
- `app.controller.ts` — the routes (see below).
- `app.service.ts` — default "Hello World" service.
- `database.service.ts` — shared Postgres connection pool; exposes
  `query(text, params)`.
- `users.service.ts` — `createUser` (hashes password, inserts) and
  `findByEmail` (joins `user_groups` to return permission flags).
- `auth.service.ts` — `login`: verifies password, signs a JWT carrying the role.
- `auth.guard.ts` — `AuthGuard`: requires a valid token ("are you logged in?").
- `admin.guard.ts` — `AdminGuard`: requires `canAdmin` in the token ("are you an admin?").

## Routes (current)

- `GET /` — hello (unguarded).
- `POST /register` — create a user with a hashed password (unguarded).
- `POST /login` — returns a JWT (unguarded; must be reachable to get a token).
- `GET /tables` — lists DB tables; guarded by `AuthGuard`.
- `GET /admin-test` — throwaway test route guarded by `AdminGuard` (remove later).

## How auth and roles work

- Passwords are hashed with **bcryptjs** (10 rounds). Never stored in plain text.
- Login signs a **JWT** (secret = `JWT_SECRET`, expires in 1 day).
- The token's payload carries the role: `sub` (user id), `email`, `groupId`,
  `groupName`, `canDownload`, `canUpload`, `canAdmin`.
- Roles live in the database: the `user_groups` table has the flags
  `can_download`, `can_upload`, `can_admin`; each user's `group_id` links to a group.
- Guards enforce: `AuthGuard` = must be logged in (else 401); `AdminGuard` =
  must have `canAdmin` (else 403). 401 = "I don't know you"; 403 = "I know you,
  not allowed".

## Database

12 tables (loaded automatically by docker-compose on first start):
`users`, `user_groups`, `resource_types`, `resources`, `renditions`,
`metadata_fields`, `resource_field_data`, `collections`, `collection_resource`,
`group_collection_access`, `email_tokens`, `audit_log`.

Seeded groups: **Administrators** (all flags true), **Editors**
(download + upload), **Viewers** (download only).

Test users (password `test1234`): `admin@test.local` (Administrators),
`editor@test.local` (Editors). Other users from experimentation may exist with
unknown passwords.

## Conventions (follow these)

- **Raw SQL only**, always with **parameterized queries** (`$1`, `$2`, …) — never
  glue user input into a query string (SQL-injection safety).
- Use **bcryptjs**, not `bcrypt` (avoids Windows native-build issues).
- All secrets/config in `backend/.env`; keep `.env` in `.gitignore`.
- Naming avoids hyphens and underscores where the name is ours to choose
  (e.g. `damassets`, `damplatform`) — a keyboard constraint.

## Gotchas / learnings (already hit and solved)

- PostgreSQL 18 Docker volume must mount at `/var/lib/postgresql`
  (NOT `/var/lib/postgresql/data`) or the container restart-loops.
- MinIO root password must be at least 8 characters or MinIO won't start.
- `.env` is read only at **startup** — fully restart the backend after editing it.
- `JwtModule` must use `registerAsync` with `ConfigService` (a plain `register`
  reading `process.env.JWT_SECRET` can run before `.env` loads → empty secret).
- Run `Invoke-RestMethod` in **PowerShell** (prompt `PS ...>`), not `cmd`.
- Snippet rule: a snippet that starts with `import` / `export class` is a WHOLE
  file (select-all, replace); a snippet that starts with a method or `@Get(...)`
  goes INSIDE the class.

## Environment

Windows 11, PowerShell, Node.js (v25 installed; project targets the v24 LTS line),
Docker Desktop. Backend tested via `Invoke-RestMethod`.

## What's next

The next feature is **upload**: a logged-in user with `canUpload` requests a
presigned URL, sends the file directly to MinIO, and the backend records it in
the `resources` table. After that: download (presigned, permission-checked),
search, collections, per-client isolation via `group_collection_access`, and the
worker for thumbnails/previews.
