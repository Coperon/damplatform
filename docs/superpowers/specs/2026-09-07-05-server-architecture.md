# Spec 05 — Server architecture and modules

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Goal

Route handlers are HTTP adapters. Domain rules, SQL, and storage live in `frontend/server/` with `import 'server-only'`. Client components do not import that tree.

## Target layout

```
frontend/
  app/                         # App Router pages + route.ts only
  components/                  # UI, no SQL
  locales/
  server/
    auth/                      # jwt cookie, password, tokens, login
    authorization/             # Principal, policies, requirePermission
    db/                        # drizzle client, schema, relations, custom sql helpers
    dal/                       # tenant-scoped queries (one file per aggregate)
    domain/                    # use-cases: createCollection, completeUpload, …
    storage/                   # S3 adapter (keys, presign, delete)
    audit/                     # write audit_events
    email/                     # nodemailer wrappers
    http/                      # AppError, parseJson, withAuth, error mapper
    jobs/                      # in-request thumbnail/exif only (no queue)
  lib/                         # client-safe: i18n, fileTypes, countries
```

Do not keep a parallel `frontend/lib/permissions.ts` CTE world. After cutover, delete unused lib modules.

## HTTP boundary

Each `route.ts`:

1. `withAuth` or explicit public.
2. Parse/validate body with a schema (Zod). Add `zod` — this is required for a validation boundary, not decoration.
3. Call one domain function with `Principal` + DTO.
4. Map `AppError` to JSON `{ message }` + status. Unknown errors 500, logged with request id, no internals.

`ctx.params` is async (Next 16). Keep that.

## Domain vs DAL

- **DAL:** functions like `findResource(tenantId, id)`, `insertResource(...)`, `listDirectFiles(tenantId, collectionId)`. Always tenant-scoped. Transactions via `db.transaction`.
- **Domain:** permission check + business rules (filename unique, parent immutable, subtree delete orchestration including storage). Domain is the only caller of DAL from routes.

Fat pages (`collections/[id]/page.tsx` ~2800 lines) are **SHOULD** split during phase 6, not a rewrite of visuals. Extract data fetching to API that already exists; extract components when touching a feature. Not an aesthetic-only refactor.

## Shared types

`frontend/server/domain/types.ts` for DTOs. Client types are pick/subset via API JSON. Do not import Drizzle types into client components.

## Error model

Keep `AppError(status, message)`. Domain throws AppError. DAL may throw; domain maps unique violation 23505 → 409.

## Validation

Zod at the edge. DAL uses typed Drizzle. Do not re-validate the same shape three times.

## Background work

No worker process. Thumbnails and EXIF run in the request that needs them (`maxDuration` as today). Failed thumbnail → resource still `ready` if original stored; rendition missing; retry endpoint for editor+.

Pending upload expiry: Vercel cron or `scripts/cleanup-pending-uploads.mjs` (Spec 08). Not Redis.

## What not to do

- Do not introduce a Nest-like “module” container.
- Do not put SQL in `app/api/**/route.ts` after phase 6.
- Do not share a global mutable cache of permissions across requests (the current WeakMap-on-JWT is replaced by DB load per request).
