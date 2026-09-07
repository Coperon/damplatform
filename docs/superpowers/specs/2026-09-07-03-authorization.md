# Spec 03 — Authorization

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Fail closed

If the principal, role, or acting tenant cannot be established, deny. Missing tenant on a client user is 403, not “show everything.” Operators who do not pass a valid acting tenant on library routes get 400/403, not an unscoped dump.

Hiding UI is not authorization.

## Principals

```ts
type Principal =
  | {
      kind: 'user';
      id: string;
      email: string;
      role: 'tenant_admin' | 'editor' | 'viewer';
      tenantId: string;
    }
  | {
      kind: 'operator';
      id: string;
      email: string;
      role: 'operator';
      actingTenantId: string | null;
    }
  | {
      kind: 'share';
      shareId: string;
      tenantId: string;
      accessLevel: 'view' | 'download';
      collectionId: string | null;
      resourceId: string | null;
    };
```

`kind: 'user'` always has `tenantId`. Library DAL for operators requires `actingTenantId` non-null.

## Acting tenant

- Client user: acting tenant **is** `users.tenantId`. Cookie `dam_acting_tenant` is **ignored**.
- Operator: acting tenant from a dedicated httpOnly cookie or header set only by operator UI after choosing a tenant. Must be a real tenant id. Invalid uuid → ignore and treat as missing.
- Share routes: no acting-tenant cookie; scope is the share row.

## Permission helper

Single module `frontend/server/authorization/policies.ts`. Route handlers call `requirePermission(principal, action)` and `requireLibraryTenant(principal)`.

Actions (canonical strings):

`collection.create | collection.rename | collection.delete | resource.upload | resource.move | resource.delete | resource.edit_metadata | resource.download | share.create | share.revoke | user.invite | user.manage | tenant.create | tenant.delete`

Mapping is the table in Spec 01. Implement as a static map, not a database matrix.

## Data access coupling

`frontend/server/dal/*` functions take `Principal` (or `LibraryContext = { tenantId, actor }`). They **always** `where tenantId = ctx.tenantId`. Operators use `actingTenantId` as that value.

Get-by-id: `AND id = $id AND tenant_id = $tenantId`. Zero rows → 404 to the client (do not leak existence across tenants). Share principal uses share scope instead of membership.

## Share scope

- Resource share: only that `resourceId`, and `resources.tenant_id = share.tenant_id`.
- Collection share: files with `collection_id = share.collection_id` only (not descendants).
- `accessLevel = view`: signed URL for thumbnail/preview only; original download 403.
- `accessLevel = download`: original allowed.
- Revoked, expired, or bad token: same generic `invalid` for existence vs wrong secret (no oracle), except already-public expired/revoked distinction on gallery GET may stay if we already expose it — **prefer generic invalid** for production.

## Operator platform APIs

Unscoped (no acting tenant): list tenants, create tenant, delete empty tenant, list operators? (operators are users with role operator). Acting tenant required: all library and tenant-user APIs.

Operator may manage users of the acting tenant including promoting to `tenant_admin`. Operator cannot set a client user’s role to `operator` through tenant user APIs; creating operators is a separate platform operation.

## IDOR

Every handler that takes `:id` loads through DAL with tenant scope (or share scope). No `SELECT * FROM resources WHERE id = $1` without tenant.

## Tests

Matrix: each role × each action × own tenant / other tenant / no auth. Operator with and without acting tenant. Share view vs download vs other resource id.
