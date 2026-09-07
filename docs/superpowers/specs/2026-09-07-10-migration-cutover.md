# Spec 10 — Data cutover and phased migration

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Philosophy

Keep the app reviewable and runnable. Do not rewrite everything then test. Characterization first. Product spec wins over prototype behavior. Wrong isolation is **not** preserved.

## Prototype facts that cannot map 1:1

- Resources with **zero** collections (unassigned)
- Resources in **multiple** collections
- Collections with **no** `tenant_id` and grants to **multiple** tenants
- Users with null tenant who are not operators (role 1 today)
- `can_access_all_tenants` role-2 users
- Role 5 pending
- Global metadata fields (`tenant_id` null)

## Mapping rules (REQUIRED, operator-reviewed before running in prod)

These must be a written runbook plus a dry-run SQL report, not guessed in code:

1. **Users**
   - `role_id = 1` → `role = operator`, `tenant_id = null`.
   - `role_id = 2` → `tenant_admin`. If `tenant_id` null, **block cutover** until assigned or converted to operator (report).
   - `role_id = 3` → `editor`; `4` → `viewer`. Null tenant → block.
   - `role_id = 5` or `status = pending` → `status = pending` or `disabled`; do not create a pending **role**.
   - `can_access_all_tenants` on role 2: **not** an operator. Report the list; human decides operator vs tenant_admin. Default: stay tenant_admin of their `tenant_id` (lose cross-tenant). Do not silently keep break-glass flags.

2. **Collections**
   - If grants exist to exactly one tenant, that tenant becomes owner.
   - If grants exist to multiple tenants: **block** and list. Human splits tree or copies. Default automated choice is **forbidden** (would steal another tenant’s files).
   - If no grants: assign to a designated operator-held staging tenant **or** block. Staging tenant is an explicit UUID in the cutover env `CUTOVER_ORPHAN_TENANT_ID`.

3. **Resources**
   - One collection: owner tenant = that collection’s new tenant; `collection_id` that collection.
   - Multiple collections: **block** and list. Human picks a primary collection (other memberships dropped after copy if needed).
   - Zero collections: put in a staging collection inside `CUTOVER_ORPHAN_TENANT_ID` named `_orphan_unassigned`, or block. Super-admin-only leftovers must not vanish.

4. **Shares / invites**
   - Inherit tenant from target collection/resource after those have tenant_id.
   - **Do not re-hash existing tokens in the cutover.** Keep bcrypt hashes in place. Application dual-verifies bcrypt (`$2`) vs SHA-256 (Phase 7). New tokens are SHA-256. Invites stay valid across the cutover.

5. **Metadata fields**
   - Global fields: copy definition into **each** tenant (new ids), remap `resource_field_data.field_id`.
   - Tenant fields: keep, already scoped.

## Phase order (runnable between phases)

| Phase | Goal | Verification |
|---|---|---|
| 0 | Characterization tests; cutover report script (read-only) | Tests pass; report reviewed |
| 1 | Drizzle schema on empty/test DBs only. Do not apply ownership rewrite to production yet. | `drizzle-kit check`; constraint tests on empty DB |
| 2 | In-place cutover in a **maintenance window** on a restored copy first, then production after backup. No `_v2` table swap. No long dual-write of CTEs + tenant_id. Deploy with Phases 3–4. | Report zero blockers; row counts match |
| 3 | Session loads user row; login checks status | Unit + login tests |
| 4 | DAL + policies; delete CTE access paths | Isolation matrix green |
| 5 | Pending uploads + key layout; optionally rewrite keys or keep old keys readable | Upload/download tests |
| 6 | Routes thin; UI copy tenant; fat page splits only where touched | Manual + typecheck |
| 7 | Rate limits, share original, token hashes, httpOnly acting tenant | Security tests |
| 8 | Logs, Sentry, CI build, compose without Redis, health | Deploy checklist |
| 9 | Playwright SHOULD; backups restore drill | Production-ready sign-off |

Storage keys: **CAN keep old keys** (`uploads/...`) after cutover to avoid rewriting the bucket. New uploads use new layout. Delete still uses `storage_key` column as-is. NOT worth a mass rename.

## Expand/migrate/contract

Do not dual-run grant CTEs and tenant_id forever. After phase 4, dead code (`tenantHasResourceAccess` recursive CTE) is deleted.

## Production-readiness checklist

- [ ] Isolation matrix CI green
- [ ] Authz matrix CI green
- [ ] Login disabled user denied
- [ ] Upload forged key denied
- [ ] Share view cannot original-download
- [ ] Folder delete removes objects (or mocked)
- [ ] Tenant delete refused when not empty
- [ ] Cutover report had zero unresolved multi-grant / multi-collection rows
- [ ] PITR backup configured; restore documented
- [ ] `next build` in CI
- [ ] Sentry or accepted risk sign-off
- [ ] Redis removed from Compose
- [ ] Env validation in deploy
- [ ] Operator acting tenant required for library APIs
