# PROGRESS.md — Build log

Day-by-day record of work on the DAM platform. Newest day at the bottom.

## Planning and design (before the build)

- Decided to build a custom DAM from scratch, inspired by ResourceSpace's
  architecture, on a modern stack.
- Settled the core principle: files in object storage, metadata in the database.
- Chose the stack: Next.js (frontend), NestJS (backend), PostgreSQL with raw SQL
  via `pg`, Redis + BullMQ, S3-compatible storage (MinIO locally), separate worker.
- Wrote requirements, security/backup/operations notes, and a 12-table schema.
- Defined roles (administrator, editor, viewer) and group-based permissions with
  per-client collection access.

## Day 1 — Tuesday, 16 June 2026

Environment preparation and backend scaffolding.

- Installed host tools (Git, Node.js, Docker Desktop) and the media tools
  (ImageMagick, FFmpeg, ExifTool, Ghostscript).
- Wrote `docker-compose.yml` for PostgreSQL, Redis, and MinIO; started them.
- PostgreSQL auto-loaded the schema on first start (all 12 tables); verified each
  service; created the private MinIO bucket `damassets`.
- Scaffolded the NestJS backend and confirmed it runs.

## Day 2 — Wednesday, 17 June 2026

Database connection, first API route, and authentication.

- Installed the `pg` driver; stored the connection in `backend/.env`
  (`DATABASE_URL`).
- Created a database service (shared connection pool, parameterized queries) and
  added `@nestjs/config`; verified the backend reads all 12 tables via `/tables`.
- Built authentication: `/register` (creates a user with a bcrypt-hashed
  password), `/login` (returns a JWT), and `AuthGuard` to protect routes.
- Verified end to end: register a user, log in for a token, and reach a guarded
  route only with a valid token (401 without one).

## Day 3 — Thursday, 18 June 2026

Roles and permissions.

- Seeded the three groups (Administrators, Editors, Viewers) with their
  capability flags, and assigned the test users to groups.
- Updated login so the JWT now carries the user's role flags
  (`canDownload`, `canUpload`, `canAdmin`).
- Built `AdminGuard`, which checks `canAdmin` and returns 403 for non-admins.
- Verified with a test route: the admin passes, the editor is forbidden (403) —
  proving the role system works (401 = not logged in, 403 = not allowed).

## Current state

Backend connected to the database, with a working authentication and
role/permission core: registration, hashed passwords, JWT login carrying roles,
and guards enforcing "logged in" and "admin only".

## Next

Upload: a `canUpload` user requests a presigned URL, uploads directly to MinIO,
and the backend records the asset in `resources`. Then download, search,
collections, per-client isolation, and the worker for thumbnails.
