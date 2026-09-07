# Spec 02 — Database model and Drizzle

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Source of truth

- **Canonical schema:** TypeScript Drizzle schema at `frontend/server/db/schema.ts` (and split files under `frontend/server/db/` if a single file grows past ~400 lines: `schema/users.ts`, `schema/library.ts`, etc., re-exported).
- **Migrations:** Drizzle Kit generate for tables/FKs/indexes/enums/checks it can express. Custom SQL in the **same** migration journal for: generated `search_vector`, GIN/`pg_trgm` indexes, `touch_updated_at` trigger, and the one-time data cutover (Spec 10).
- **One runner.** After cutover, `drizzle-kit migrate` (or a thin wrapper that uses the Drizzle journal) is the only applier. Historical `db/migrations/0001_baseline.sql` and `0002_prod_hardening.sql` remain applied history; they are not edited. New objects are not hand-authored in `db/migrations/` in parallel.
- Route handlers and domain code **do not** import `pg` Pool for queries. The Drizzle client (and `db.execute(sql\`...\`)` inside the DAL) is the only query path.

## Dropped objects

`tenant_collection_access`, `collection_resource`, `tenant_role_permissions`, `roles`, `resource_types`, `users.can_access_all_tenants`, `users.can_invite`, `users.role_id` integer FK.

Overlapping `access_log` and `audit_log` are replaced by `audit_events`.

## Enums

```ts
export const userRoleEnum = pgEnum('user_role', [
  'operator',
  'tenant_admin',
  'editor',
  'viewer',
]);

export const userStatusEnum = pgEnum('user_status', [
  'pending',
  'active',
  'disabled',
]);

export const resourceStatusEnum = pgEnum('resource_status', [
  'uploading',
  'processing',
  'ready',
  'failed',
]);

export const shareAccessEnum = pgEnum('share_access', ['view', 'download']);
```

Login allows only `user_status = active`. Invite redeem sets `active` (and `emailVerified = true`). `pending` remains for incomplete invite rows if needed; unused pending **role** is gone.

## Tables (production)

### tenants

- `id` uuid PK default random
- `name` text not null
- `address`, `phone` text null
- `createdAt` timestamptz not null default now
- Unique name is **not** required (two “Acme” tenants can exist). Optional later.

ON DELETE: children **RESTRICT** (users, collections). Application refuses delete unless counts are zero.

### users

- `id` uuid PK
- `email` text not null unique
- `passwordHash` text not null
- `name`, `phone` text null
- `status` user_status not null default `pending`
- `emailVerified` boolean not null default false
- `role` user_role not null
- `tenantId` uuid null FK → tenants.id **ON DELETE RESTRICT**
- `createdAt` timestamptz not null

**CHECK:** `(role = 'operator' AND tenant_id IS NULL) OR (role IN ('tenant_admin','editor','viewer') AND tenant_id IS NOT NULL)`

### collections

- `id` uuid PK
- `tenantId` uuid not null FK → tenants **ON DELETE RESTRICT**
- `parentId` uuid null
- `name` text not null
- `coverStorageKey` text null
- `createdBy` uuid null FK → users ON DELETE SET NULL
- `createdAt` timestamptz not null
- Unique `(id, tenantId)` for composite FKs
- Index `(tenantId, parentId)`
- CHECK `parent_id IS DISTINCT FROM id`
- Composite FK `(parentId, tenantId)` → `collections(id, tenantId)` ON DELETE **CASCADE** (subtree folders)
- **No UPDATE of `parentId` in application or SQL.** Enforce with a trigger `PreventCollectionParentChange` that raises on `parent_id` change, declared in custom SQL.

Because parent is immutable, a new row cannot be a descendant of itself except `parent_id = id`, which the CHECK blocks.

### resources

- `id` uuid PK
- `tenantId` uuid not null
- `collectionId` uuid not null
- Composite FK `(collectionId, tenantId)` → collections ON DELETE **CASCADE**
- `title` text null
- `originalFilename` text not null
- Unique `(collectionId, originalFilename)`
- `storageKey` text not null unique
- `checksumSha256` text null
- `mimeType` text not null
- `sizeBytes` bigint not null
- `status` resource_status not null default `uploading`
- `width`, `height`, `durationSeconds` null
- `description`, `extractedText` text null
- `createdBy` uuid null FK users SET NULL
- `createdAt`, `updatedAt` timestamptz
- `thumbnailStorageKey` text null (or rely solely on renditions; prefer **renditions** as source of truth and drop the denormalized column if unused after cutover)
- `searchVector` tsvector generated (custom SQL)

### renditions

Unchanged idea: `(resourceId, kind)` unique, `kind` in `thumbnail | preview`, `storageKey` unique, CASCADE from resource.

### metadata_fields

- `id` uuid PK (switch from serial — avoid a global sequence across tenants)
- `tenantId` uuid not null FK tenants ON DELETE **RESTRICT** (drain tenant including fields, or CASCADE fields after resources gone — **CASCADE is OK** if resources already gone; field data CASCADE from field)
- `name`, `fieldType`, `searchable`, `sortOrder`, `options`, `required`, `exifSource`
- Unique `(tenantId, name)`

No global `tenant_id IS NULL` fields. Seed defaults in application when a tenant is created (Spec 05).

### resource_field_data

PK `(resourceId, fieldId)`, both CASCADE. Values stay tenant-correct because resource and field both belong to a tenant; add a CHECK via composite if we also store `tenantId` on the value row (optional denormalization — **skip**, rely on FKs).

### shares

- `id` uuid PK
- `tenantId` uuid not null
- `tokenHash` text not null **unique**
- `tokenEncrypted` text null (admin copy-link; keep AES-GCM)
- `collectionId` uuid null
- `resourceId` uuid null
- CHECK exactly one of collection/resource non-null
- Composite FKs to collection/resource **same tenant**
- `accessLevel` share_access not null
- `expiresAt` timestamptz null
- `revoked` boolean not null default false
- `label` text null
- `createdBy` uuid null SET NULL
- `createdAt`, `lastUsedAt`

### invitations

- `id` uuid PK
- `tenantId` uuid not null ON DELETE CASCADE (invites die with tenant only after users/files drained — actually tenant delete is refused while users exist; leftover invites: **ON DELETE CASCADE** is fine once empty of users/files; invitations are not a block. Spec 10: tenant delete allowed when users=0, resources=0, collections=0; invitations may CASCADE.)
- Wait: if invitations remain, tenant delete? Product said refuse while users or files. Invitations are neither. **CASCADE invitations on tenant delete.**
- `tokenHash` text not null **unique**
- `email` text not null
- `role` user_role not null CHECK `role IN ('tenant_admin','editor','viewer')`
- `invitedBy` uuid null SET NULL
- `expiresAt`, `acceptedAt`, `createdAt`

### pending_uploads

New. Binds presign to complete.

- `id` uuid PK
- `tenantId` uuid not null
- `collectionId` uuid not null
- Composite FK to collection same tenant
- `userId` uuid not null FK users
- `storageKey` text not null unique
- `filename` text not null
- `mimeType` text not null
- `maxBytes` bigint not null
- `expiresAt` timestamptz not null
- `consumedAt` timestamptz null

Complete must match an unconsumed unexpired row for this user and key.

### email_tokens

Keep. `tokenHash` unique. Purposes: `verify | reset | email_change`.

### audit_events

- `id` uuid PK
- `actorUserId` uuid null SET NULL
- `actorRole` text null (snapshot)
- `tenantId` uuid null (acting tenant; null for platform-only events)
- `action` text not null
- `targetType` text null
- `targetId` uuid null
- `ip` text null
- `metadata` jsonb not null default `{}`
- `createdAt` timestamptz not null
- Indexes `(tenantId, createdAt)`, `(actorUserId, createdAt)`, `(action, createdAt)`

### rate_limit_events

Keep as in 0002.

## Search

Custom SQL: generated `tsvector` on resources (title, filename, description, extracted text) + GIN. Every search query **AND tenant_id = acting tenant**.

## Transactions

Required for: upload complete, file move (unique filename check), subtree delete (list keys → delete rows → caller deletes S3), invite redeem, email change confirm, share create.

## What Drizzle does not own

Document in `frontend/server/db/extras.sql.md` (or comments in schema): search_vector expression, trgm indexes, parent-immutability trigger. Custom migration files next to generated ones.

## Testing this spec

Integration tests against Postgres: CHECK rejects operator with tenantId; composite FK rejects cross-tenant collection_id; parent update trigger fires; unique filename per collection; tenant delete RESTRICT.
