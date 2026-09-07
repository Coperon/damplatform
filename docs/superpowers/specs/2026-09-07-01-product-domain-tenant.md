# Spec 01 — Product, tenant, and roles

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Purpose

Define the production domain. The prototype (operator-owned global tree + `tenant_collection_access` grants) is **not** this product.

## Tenant

A tenant is a client organization that **owns** a private DAM library: collections, files, metadata field definitions, invitations, and share links.

Tenants do not grant folders to other tenants. The only way a non-member sees a file is a public share URL.

## Users

- A client user belongs to **exactly one** tenant.
- A person who works for two clients has two accounts.
- Platform **operators** are not members of client tenants (`tenant_id` is null).
- Operators may list, open, upload, edit, share, and delete in any tenant library (**break-glass**), always against an **acting tenant id** they must select.

## Library shape

- Forest of collections (`parent_id` null = top-level).
- Parent is set at create and **never updated**.
- Every file has **exactly one** collection. No inbox, no unassigned, no M2M.
- Upload must specify a collection.
- Editors and tenant admins may **move** a file to another collection in the same tenant.
- Everyone in the tenant **sees the entire library**. Folders are organization, not ACL.

## Destructive operations

- Delete collection: delete that folder, descendant folders, files in the subtree, renditions, field data, shares targeting those rows, then object-storage bytes.
- Delete tenant (operator only): **refused** while any user, resource, or collection exists. Drain first.

## Roles and actions

| Action | Viewer | Editor | Tenant admin | Operator |
|---|---|---|---|---|
| Browse / preview | yes | yes | yes | yes (acting tenant) |
| Download original in-app | yes | yes | yes | yes |
| Upload / replace | no | yes | yes | yes |
| Move file | no | yes | yes | yes |
| Edit metadata | no | yes | yes | yes |
| Create / rename collection | no | yes | yes | yes |
| Delete file | no | yes | yes | yes |
| Delete collection (subtree) | no | yes | yes | yes |
| Create / revoke share | no | no | yes | yes |
| Invite / disable tenant users | no | no | yes | yes |
| Change tenant user roles (not to operator) | no | no | yes | yes |
| Create / delete tenant | no | no | no | yes |
| Act without an acting tenant on library data | n/a | n/a | n/a | no |

Tenant admin may invite `tenant_admin`, `editor`, or `viewer` into **their** tenant. Nobody is invited as `operator` through invitations.

## Share links

- Created only by tenant admin or operator.
- Target: one collection **or** one resource, same tenant.
- Collection target: files **directly** in that collection, not descendants.
- Access level chosen at create: `view` (no original download) or `download`.
- Must support expiry and revoke (keep existing product capability).

## Audit

Record: login success/failure, invites, role/user changes, share create/revoke, tenant create/delete attempts, operator actions on a client tenant, permanent file/folder delete, original downloads. Do not record every preview.

## Naming

Live language is **tenant**, not company. UI/i18n should follow (implementation phase for copy). Constraint names from the companies era are dropped in the new schema.

## Out of scope

Billing, SSO, SCIM, per-folder ACLs, tenant-to-tenant sharing, multi-tenant user membership.
