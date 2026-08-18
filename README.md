# DAM Platform

A multi-tenant Digital Asset Management platform. Coperon uploads assets
(images, video, audio, PDFs); client tenants log in and see only the
collections shared with them. Files live in object storage — only metadata
lives in the database.

## Layout

| Path | What it is |
|---|---|
| `frontend/` | The Next.js 16 application (App Router). UI *and* API routes. |
| `damInfra/` | Docker Compose for Postgres, Redis, and MinIO. |
| `db/migrations/` | Schema migrations, applied in filename order. Append-only. |
| `db/seeds/` | Reference data (roles) needed for a working install. |
| `docs/` | `STATE.md` is the current state of the project. |

There is no separate backend process — the API routes in `frontend/app/api/`
are the backend.

## Running locally

1. Start Docker Desktop, then in `damInfra/`: `docker compose start`
   (expect `dam_postgres`, `dam_minio` up). Use `stop`, never `down -v`.
2. Copy `frontend/.env.example` to `frontend/.env.local` and fill it in.
3. Apply migrations: `cd frontend && node scripts/migrate.mjs`
4. `npm install && npm run dev` → http://localhost:3000

## Migrations

```
node scripts/migrate.mjs            # apply anything pending
node scripts/migrate.mjs --status   # show applied vs pending
```

Never edit a migration that has already been applied — the runner stores a
checksum and will refuse to continue. Add a new numbered file instead.

## Stack

Next.js 16 (React 19) · PostgreSQL 18 via raw SQL on the `pg` driver (no ORM,
deliberately) · MinIO for S3-compatible object storage · JWT auth ·
Tailwind CSS 4.
