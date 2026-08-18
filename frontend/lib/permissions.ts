import db from './db';
import type { JwtPayload } from './session';
import { canAccessAllTenants, requireAuth } from './session';

// ---------------------------------------------------------------------------
// Stage 108: per-tenant editor/viewer permissions.
//
// Admin (role 2) and super-admin (role 1) capability stays fixed — never
// configurable, never looked up here — this is the guard against a tenant
// admin escalating their own role. Only editor (3) and viewer (4) capability
// is configurable, per tenant, via the tenant_role_permissions table.
//
// Absence of a row = the code-defined default below. Only overrides are ever
// stored, so a brand-new tenant needs no seeding and a brand-new permission
// key added in a future stage gets a sensible default automatically, for
// every existing tenant, with no backfill.
// ---------------------------------------------------------------------------

export const EDITOR_PERMISSION_KEYS = [
  'upload',
  'edit_metadata',
  'rename_asset',
  'regenerate_thumbnail',
  'remove_from_collection',
  'add_to_collection',
  'create_share',
  'create_collection',
  'rename_collection',
  'delete_permanently',
] as const;
export type EditorPermissionKey = (typeof EDITOR_PERMISSION_KEYS)[number];

export const VIEWER_PERMISSION_KEYS = ['download', 'view_metadata', 'create_share'] as const;
export type ViewerPermissionKey = (typeof VIEWER_PERMISSION_KEYS)[number];

export type PermissionKey = EditorPermissionKey | ViewerPermissionKey;

// Every distinct key across both lists ('create_share' appears in both —
// counted once), for building a combined "my effective permissions" bundle.
export const ALL_PERMISSION_KEYS: PermissionKey[] = Array.from(
  new Set<PermissionKey>([...EDITOR_PERMISSION_KEYS, ...VIEWER_PERMISSION_KEYS]),
);

// Defaults mirror exactly what's true on disk today (audited route by route,
// not guessed — see Stage 108's changelog entry for the full route-by-route
// derivation): upload/edit_metadata/remove_from_collection were already
// reachable by any editor (canUpload); everything else editors could try
// today was actually requireAdmin-gated (rename/thumbnail/add-to-collection/
// create+rename collection/delete-permanently/create-share all 403 an editor
// right now) — including add_to_collection, which reads as "on" in a naive
// skim of canUpload call sites but is really requireAdmin-only, a correction
// worth flagging explicitly since it's easy to get backwards.
export const EDITOR_DEFAULTS: Record<EditorPermissionKey, boolean> = {
  upload: true,
  edit_metadata: true,
  rename_asset: false,
  regenerate_thumbnail: false,
  remove_from_collection: true,
  add_to_collection: false,
  create_share: false,
  create_collection: false,
  rename_collection: false,
  delete_permanently: false,
};

// download/view_metadata are open to any role with resource access today
// (requireDownload's canDownload already includes viewers; GET .../metadata
// is requireAuth-only); create_share is requireAdmin-only, same as for editors.
export const VIEWER_DEFAULTS: Record<ViewerPermissionKey, boolean> = {
  download: true,
  view_metadata: true,
  create_share: false,
};

// download/view_metadata are viewer-configurable only — an editor's baseline
// access already includes both, unconditionally, today (see the defaults
// above: an editor was never gated on either by role). Listed here so
// hasPermission can special-case them before falling through to
// EDITOR_DEFAULTS, which doesn't define either key at all.
const EDITOR_IMPLICIT_TRUE: ReadonlySet<PermissionKey> = new Set(['download', 'view_metadata']);

function defaultFor(roleId: number, key: PermissionKey): boolean | undefined {
  if (roleId === 3 && (EDITOR_PERMISSION_KEYS as readonly string[]).includes(key)) {
    return EDITOR_DEFAULTS[key as EditorPermissionKey];
  }
  if (roleId === 4 && (VIEWER_PERMISSION_KEYS as readonly string[]).includes(key)) {
    return VIEWER_DEFAULTS[key as ViewerPermissionKey];
  }
  return undefined;
}

// Per-request memoization: keyed on the JwtPayload object reference itself,
// which requireAuth/jwt.verify mints fresh on every request — so a WeakMap
// entry is reachable only for the lifetime of the one request that decoded
// it, and is eligible for GC the moment that request's closures are gone.
// No module-level mutable cache, no cross-request/cross-user leak risk, and
// every hasPermission() call for the same user within one request shares the
// same single query (even multiple concurrent calls share the same pending
// promise) rather than issuing N queries.
const overridesCache = new WeakMap<object, Promise<Map<string, boolean>>>();

function loadOverrides(user: Pick<JwtPayload, 'tenantId' | 'roleId'>): Promise<Map<string, boolean>> {
  let promise = overridesCache.get(user);
  if (!promise) {
    promise = (async () => {
      const map = new Map<string, boolean>();
      if (user.tenantId && (user.roleId === 3 || user.roleId === 4)) {
        const result = await db.query<{ permission_key: string; enabled: boolean }>(
          'SELECT permission_key, enabled FROM tenant_role_permissions WHERE tenant_id = $1 AND role_id = $2',
          [user.tenantId, user.roleId],
        );
        for (const row of result.rows) map.set(row.permission_key, row.enabled);
      }
      return map;
    })();
    overridesCache.set(user, promise);
  }
  return promise;
}

// The resolver. Super admin and any admin with cross-tenant access: always
// true (their access is already unrestricted everywhere, this is not a new
// bypass). Admin (role 2, without cross-tenant access): also always true —
// fixed, not configurable, the guard against a tenant admin escalating
// their own role. Editor/viewer: DB-backed, per
// tenant, falling back to the code default above when no override row
// exists. Fails closed on a missing tenantId (old token, or a data anomaly) —
// same convention as tenantHasResourceAccess/tenantHasCollectionAccess.
export async function hasPermission(
  user: Pick<JwtPayload, 'roleId' | 'tenantId' | 'canAccessAllTenants'>,
  key: PermissionKey,
): Promise<boolean> {
  if (canAccessAllTenants(user)) return true;
  if (user.roleId === 1 || user.roleId === 2) return true;

  if (user.roleId === 3 && EDITOR_IMPLICIT_TRUE.has(key)) return true;

  if (user.roleId !== 3 && user.roleId !== 4) return false;
  if (!user.tenantId) return false;

  const def = defaultFor(user.roleId, key);
  if (def === undefined) return false;

  const overrides = await loadOverrides(user);
  return overrides.has(key) ? overrides.get(key)! : def;
}

// Route-handler guard mirroring lib/session.ts's requireAdmin/requireUpload/
// requireDownload shape — a route swaps `requireUpload(request)` for
// `requirePermission(request, 'upload')` and everything else about the call
// site (the `instanceof Response` early-return) is unchanged.
export async function requirePermission(
  request: Request,
  key: PermissionKey,
): Promise<JwtPayload | Response> {
  const result = requireAuth(request);
  if (result instanceof Response) return result;
  if (!(await hasPermission(result, key))) {
    return Response.json({ message: 'Permission denied' }, { status: 403 });
  }
  return result;
}

// Every key's resolved value for the CALLING user's own actual role — what
// the frontend needs to decide which buttons/kebab items to render, in one
// shot (one query at most, via the same memoized loadOverrides above; admin/
// super-admin/cross-tenant-access short-circuit to all-true with no query at all).
export async function getEffectivePermissions(
  user: Pick<JwtPayload, 'roleId' | 'tenantId' | 'canAccessAllTenants'>,
): Promise<Record<PermissionKey, boolean>> {
  const result = {} as Record<PermissionKey, boolean>;
  for (const key of ALL_PERMISSION_KEYS) {
    result[key] = await hasPermission(user, key);
  }
  return result;
}

// INTERIM DECISION (reverses Stage 6's "Coperon alone controls collections"
// call, pending the returning decision-maker's review): a tenant admin may
// edit which tenants can access a collection they can reach, restricted to
// toggling their own tenant's row only (see PUT /api/collections/[id]/access).
// Every route that gates on this rule reads this single constant — flip it to
// false to revert to super-admin-only access editing without touching any
// route.
export const TENANT_ADMIN_CAN_EDIT_ACCESS = true;

// Does `tenantId` have access to `resourceId` via the resource's own collection
// membership? Walks every collection the resource belongs to upward through
// parent_id (root_finder), then checks tenant_collection_access for that
// tenant at any level in that chain — not just the root (Stage 88: was
// root-only) — the exact cascade already used by GET /api/download/[id]
// and (inline) GET /api/resources/[id]/metadata's non-admin read check.
// Factored out here so canEditResourceMetadata below reuses it verbatim
// instead of a second, looser variant. `tenantId === null` (no tenant) is
// handled by the caller, before this ever runs — never passed through to a
// query, since `tenant_id = NULL` isn't a valid grant to check.
// Exported so the newly tenant-scoped resource routes (rename, permanent
// delete, thumbnail regeneration) reuse this exact cascade too, instead of a
// second access path.
export async function tenantHasResourceAccess(tenantId: string, resourceId: string): Promise<boolean> {
  const result = await db.query(
    `WITH RECURSIVE root_finder AS (
       SELECT c.id, c.parent_id
       FROM collections c
       INNER JOIN collection_resource cr ON cr.collection_id = c.id
       WHERE cr.resource_id = $1
       UNION ALL
       SELECT c.id, c.parent_id
       FROM collections c
       INNER JOIN root_finder rf ON rf.parent_id = c.id
       WHERE rf.parent_id IS NOT NULL
     )
     SELECT 1 FROM root_finder rf
     INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.id
     WHERE cca.tenant_id = $2
     LIMIT 1`,
    [resourceId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

// Does `tenantId` have access to `collectionId` itself — same any-depth
// cascade as tenantHasResourceAccess above, just seeded directly from the
// collection instead of walking up from a resource's membership first. This
// is the single helper every newly tenant-scoped collection/share/upload
// route below reuses (collection create/rename/delete, the access editor,
// shares, thumbnail regeneration, URL import) — never a second, parallel
// cascade query. `tenantId === null` is the caller's responsibility to
// short-circuit before calling this, same convention as the sibling helper.
export async function tenantHasCollectionAccess(tenantId: string, collectionId: string): Promise<boolean> {
  const result = await db.query(
    `WITH RECURSIVE root_finder AS (
       SELECT id, parent_id FROM collections WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent_id
       FROM collections c
       INNER JOIN root_finder rf ON rf.parent_id = c.id
       WHERE rf.parent_id IS NOT NULL
     )
     SELECT 1 FROM root_finder rf
     INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.id
     WHERE cca.tenant_id = $2
     LIMIT 1`,
    [collectionId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

// Can this user author (read/write) per-asset metadata on `resourceId`?
// Super admins: unconditionally yes. Everyone else with upload capability
// (editors, and — Stage 6 — tenant admins, who also carry canUpload: true):
// yes only if the resource belongs to at least one collection their tenant
// can reach — same isolation as every other non-admin resource check in this
// app, not a new permission surface. A tenant admin is deliberately treated
// like an editor here, not given the unconditional bypass: `user.canAdmin`
// alone can no longer mean "true super admin" (Stage 6 also grants it to
// tenant admins), so the bypass must key off `isSuperAdmin` instead.
// Everyone else (viewers, no-permission accounts): no — viewers keep
// read-only access via GET /api/resources/[id]/metadata's own (broader,
// unchanged) access check, which this helper does not govern.
// Fail closed: an editor/admin with no tenant (tenantId null/undefined —
// an old token, or a data anomaly) gets false without ever reaching the query.
export async function canEditResourceMetadata(
  user: Pick<JwtPayload, 'canAdmin' | 'canUpload' | 'tenantId' | 'roleId' | 'canAccessAllTenants'>,
  resourceId: string,
): Promise<boolean> {
  // Cross-tenant access (role 1, or role 2 with the can_access_all_tenants
  // flag) → unrestricted, any tenant's resources — the Stage "third branch";
  // was isSuperAdmin only.
  if (canAccessAllTenants(user)) return true;
  if (!user.canUpload) return false;
  // Stage 108: an editor's ability to author metadata is now the per-tenant
  // 'edit_metadata' permission. A no-op for role 2 (admin) — hasPermission
  // already returns true unconditionally for roleId 1/2 — so this only ever
  // actually gates role 3.
  if (!(await hasPermission(user, 'edit_metadata'))) return false;
  if (!user.tenantId) return false;
  return tenantHasResourceAccess(user.tenantId, resourceId);
}
