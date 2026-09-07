# Spec 08 — Observability, operations, deployment

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Logging

Structured JSON logs on the server: `time`, `level`, `requestId`, `route`, `userId` (if any), `tenantId` (acting), `msg`. Generate `requestId` in `withAuth` / middleware header `x-request-id`. No `pino` requirement if a 20-line helper suffices; either is fine. Do not log bodies that may contain passwords.

## Error monitoring

SHOULD: Sentry (or equivalent) DSN from env. Capture 500s. Do not send tokens.

## Metrics

CAN wait. Sentry + audit_events + Vercel logs are enough for v1 production.

## Health

`GET /api/health` unauthenticated:

- `SELECT 1` (required)
- Optional: HeadBucket / cheap S3 call behind `?deep=1` or always if latency stays low
- HTTP 503 if DB down
- Include region and commit as today

Readiness for deploy: same as health unless we add a migrate lock (not required).

## Environment

Validate at boot (Next instrumentation or `check-env` in `predev`/`build`). Fail deploy if required secrets missing.

## Migrations in deploy

Run Drizzle migrate against `DIRECT_DATABASE_URL` in CI/CD **before** shifting traffic (Vercel build command or a GitHub Action). Do not run migrate from a pooled connection.

Rollback: forward-fix with a new migration. Never edit applied files. App versions that require new columns must deploy **after** migrate.

## Backups

REQUIRED operationally: Postgres PITR (Neon/Supabase/host). Object storage versioning or lifecycle **SHOULD**. Restore tested once before calling the system production-ready (runbook in README). Code cannot substitute for this.

## Compose

Remove Redis service. Postgres + MinIO only.

## CI

`.github/workflows/ci.yml`: `npm ci`, `typecheck`, `vitest`, **`next build`**, integration tests if `DATABASE_URL` available (service container Postgres).

## Vercel

Keep `dub1`, `serverExternalPackages` / tracing for thumbnails. `PG_POOL_MAX=1` documented for serverless. Drizzle client uses the same pool settings.

## Cron / cleanup

SHOULD: daily delete `pending_uploads` expired and unconsumed; delete `rate_limit_events` older than 2 days (already probabilistic). Vercel cron hitting a secret-header route, or a script.

## Thumbnails payload

Keep tracing includes. Document 250 MB limit. If Linux ffmpeg exceeds, Spec 06 fallback is “no video thumb” rather than a queue.
