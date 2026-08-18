import { NextRequest, NextResponse } from 'next/server';
import type { Pool, PoolClient } from 'pg';
import db from '@/lib/db';
import { requireSuperAdmin } from '@/lib/session';
import { logAccess } from '@/lib/accessLog';
import { deleteObject } from '@/lib/storage';

type Executor = Pool | PoolClient;

// A collection is "exclusive" to a tenant when no ancestor-or-self in its
// chain carries a grant for any OTHER tenant — i.e. this tenant is the only
// one who can reach it, at any depth. Walks every collection up to its root
// (same shape as lib/permissions.ts's tenantHasCollectionAccess, run for
// every collection at once rather than one lookup at a time) and groups the
// tenant ids found anywhere in each chain: a chain containing only this
// tenant's id is exclusive; one containing this tenant's id AND at least one
// other is shared and must survive. Collections this tenant can't reach at
// all are excluded by the HAVING clause — never touched.
async function computeCollectionExclusivity(
  executor: Executor,
  tenantId: string,
): Promise<{ exclusiveIds: string[]; sharedIds: string[] }> {
  const result = await executor.query<{ collection_id: string; reachable_by_other: boolean }>(
    `WITH RECURSIVE root_finder AS (
       SELECT id AS original_id, id AS current_id, parent_id AS current_parent
       FROM collections
       UNION ALL
       SELECT rf.original_id, c.id, c.parent_id
       FROM root_finder rf
       JOIN collections c ON c.id = rf.current_parent
       WHERE rf.current_parent IS NOT NULL
     ),
     chain_grants AS (
       SELECT DISTINCT rf.original_id AS collection_id, tca.tenant_id
       FROM root_finder rf
       JOIN tenant_collection_access tca ON tca.collection_id = rf.current_id
     )
     SELECT collection_id, bool_or(tenant_id <> $1) AS reachable_by_other
     FROM chain_grants
     GROUP BY collection_id
     HAVING bool_or(tenant_id = $1)`,
    [tenantId],
  );

  const exclusiveIds: string[] = [];
  const sharedIds: string[] = [];
  for (const row of result.rows) {
    (row.reachable_by_other ? sharedIds : exclusiveIds).push(row.collection_id);
  }
  return { exclusiveIds, sharedIds };
}

// A resource is exclusive to the tenant being deleted only if EVERY
// collection it belongs to is in the exclusive set above — one surviving
// membership (a shared collection, or another tenant's entirely) means the
// resource itself must survive; only its links into the deleted collections
// go away, via collections' own ON DELETE CASCADE on collection_resource.
async function computeExclusiveResources(
  executor: Executor,
  exclusiveCollectionIds: string[],
): Promise<{ id: string; storage_key: string; thumbnail_storage_key: string | null }[]> {
  if (exclusiveCollectionIds.length === 0) return [];
  const result = await executor.query<{
    id: string;
    storage_key: string;
    thumbnail_storage_key: string | null;
  }>(
    `WITH resource_candidates AS (
       SELECT DISTINCT resource_id FROM collection_resource WHERE collection_id = ANY($1::uuid[])
     )
     SELECT r.id, r.storage_key, r.thumbnail_storage_key
     FROM resource_candidates rc
     JOIN resources r ON r.id = rc.resource_id
     WHERE NOT EXISTS (
       SELECT 1 FROM collection_resource cr2
       WHERE cr2.resource_id = rc.resource_id
       AND cr2.collection_id <> ALL($1::uuid[])
     )`,
    [exclusiveCollectionIds],
  );
  return result.rows;
}

// Read-only preview — the exact same two queries DELETE below runs, so the
// confirmation modal's counts can never drift from what the real delete does.
// Super-admin-only, same tier as the rest of tenant management.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = requireSuperAdmin(req);
  if (admin instanceof Response) return admin;

  const { id } = await ctx.params;

  const tenantResult = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM tenants WHERE id = $1',
    [id],
  );
  if (tenantResult.rowCount === 0) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }
  const tenant = tenantResult.rows[0];

  const userCountResult = await db.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1',
    [id],
  );

  const { exclusiveIds, sharedIds } = await computeCollectionExclusivity(db, id);
  const exclusiveResources = await computeExclusiveResources(db, exclusiveIds);

  return NextResponse.json({
    id: tenant.id,
    name: tenant.name,
    userCount: userCountResult.rows[0].n,
    collectionsToDelete: exclusiveIds.length,
    collectionsSkippedShared: sharedIds.length,
    resourcesToDelete: exclusiveResources.length,
  });
}

// Permanent tenant deletion. Super-admin-only (not requireAdmin — a tenant
// admin gets 403 even for their own tenant, no self-service path exists).
// Requires the tenant's exact current name as `confirmName`, checked
// server-side so a UI bug or a direct API call can't skip it. One
// transaction for every DB change; MinIO object deletion happens only after
// that transaction commits (an orphaned object is recoverable, a half
// rolled-back DB is not) and a failed object delete is logged, never fatal.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = requireSuperAdmin(req);
  if (admin instanceof Response) return admin;

  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName.trim() : '';

  let tenant: { id: string; name: string };
  let usersDeleted = 0;
  let exclusiveIds: string[] = [];
  let sharedIds: string[] = [];
  let exclusiveResources: { id: string; storage_key: string; thumbnail_storage_key: string | null }[] = [];
  let invitationsDeleted = 0;
  let metadataFieldsDeleted = 0;
  let permissionOverridesDeleted = 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the tenant row for the duration of this transaction — mirrors
    // DELETE /api/users/[id]'s own FOR UPDATE, same reason: no concurrent
    // delete of the same tenant can race past the checks below.
    const tenantResult = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (tenantResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    tenant = tenantResult.rows[0];

    // Case-sensitive, trimmed exact match — a mismatch (including an empty
    // field) is a 400, nothing deleted. Checked before any destructive query.
    if (confirmName !== tenant.name) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'Company name confirmation does not match.' },
        { status: 400 },
      );
    }

    // Shouldn't happen — super admins have no tenant, by construction — but
    // fail loudly here rather than ever deleting one out from under itself.
    const superAdminCheck = await client.query(
      'SELECT id FROM users WHERE tenant_id = $1 AND role_id = 1 LIMIT 1',
      [id],
    );
    if ((superAdminCheck.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'This company has a super admin account attached to it — refusing to delete.' },
        { status: 409 },
      );
    }

    const userCountResult = await client.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1',
      [id],
    );
    usersDeleted = userCountResult.rows[0].n;

    const exclusivity = await computeCollectionExclusivity(client, id);
    exclusiveIds = exclusivity.exclusiveIds;
    sharedIds = exclusivity.sharedIds;

    // Protect shared subtrees from collections.parent_id's own ON DELETE
    // CASCADE: if an exclusive collection is about to be deleted and one of
    // its direct children is shared (reachable by another tenant via its own
    // grant), detach the child first so the cascade never reaches it. Every
    // collection beneath a shared collection is provably shared too — the
    // same ancestor-chain grant that makes the child shared is inherited by
    // everything under it — so a single one-level detach pass is sufficient,
    // no recursion needed.
    if (exclusiveIds.length > 0 && sharedIds.length > 0) {
      await client.query(
        'UPDATE collections SET parent_id = NULL WHERE id = ANY($1::uuid[]) AND parent_id = ANY($2::uuid[])',
        [sharedIds, exclusiveIds],
      );
    }

    exclusiveResources = await computeExclusiveResources(client, exclusiveIds);

    // Clear any surviving collection's cover pointing at a file that's about
    // to be deleted — same hygiene as DELETE /api/resources/[id] — before the
    // resource rows (and therefore these storage keys) are gone.
    if (exclusiveResources.length > 0) {
      const staleKeys = exclusiveResources.flatMap((r) =>
        r.thumbnail_storage_key ? [r.storage_key, r.thumbnail_storage_key] : [r.storage_key],
      );
      await client.query('UPDATE collections SET cover_storage_key = NULL WHERE cover_storage_key = ANY($1)', [
        staleKeys,
      ]);
    }

    // Resources first (cascades collection_resource/renditions/
    // resource_field_data/shares), then the exclusive collections themselves
    // (cascades any remaining collection_resource links, sub-collections,
    // shares, and this tenant's own tenant_collection_access rows on them).
    if (exclusiveResources.length > 0) {
      await client.query(
        'DELETE FROM resources WHERE id = ANY($1::uuid[])',
        [exclusiveResources.map((r) => r.id)],
      );
    }
    if (exclusiveIds.length > 0) {
      await client.query('DELETE FROM collections WHERE id = ANY($1::uuid[])', [exclusiveIds]);
    }

    // Counts for the audit metadata below, taken before the cascades that
    // remove these rows fire (they have no independent DELETE of their own —
    // tenants.id ON DELETE CASCADE handles all three).
    invitationsDeleted = (
      await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM invitations WHERE tenant_id = $1', [id])
    ).rows[0].n;
    metadataFieldsDeleted = (
      await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM metadata_fields WHERE tenant_id = $1', [id])
    ).rows[0].n;
    permissionOverridesDeleted = (
      await client.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM tenant_role_permissions WHERE tenant_id = $1',
        [id],
      )
    ).rows[0].n;

    // Users before the tenant row — users.tenant_id has no ON DELETE action
    // of its own (deliberately: a user must never survive with a dangling
    // tenant reference), so it must be empty before DELETE FROM tenants runs.
    await client.query('DELETE FROM users WHERE tenant_id = $1', [id]);

    // Cascades invitations, this tenant's remaining tenant_collection_access
    // rows (grants on shared/other-tenant collections, detached above),
    // metadata_fields (+ their resource_field_data), and
    // tenant_role_permissions. access_log.tenant_id is ON DELETE SET NULL —
    // untouched by this statement's cascade graph, exactly as required.
    await client.query('DELETE FROM tenants WHERE id = $1', [id]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // MinIO cleanup after the transaction has committed — a failed object
  // delete is logged and skipped, never rolled back into the DB state.
  for (const resource of exclusiveResources) {
    try {
      await deleteObject(resource.storage_key);
    } catch (err) {
      console.error('MinIO delete failed for key', resource.storage_key, err);
    }
    if (resource.thumbnail_storage_key) {
      try {
        await deleteObject(resource.thumbnail_storage_key);
      } catch (err) {
        console.error('MinIO delete failed for key', resource.thumbnail_storage_key, err);
      }
    }
  }

  // Fire-and-forget, only after the delete actually committed. tenant_id is
  // the ACTOR's own tenant — null here, since only a super admin ever reaches
  // this route and super admins have no tenant — same convention as
  // user_delete/all_tenants_flag_change/invite_flag_change: the target no
  // longer exists to join against, so every identifying field is captured by
  // value in metadata instead.
  logAccess({
    userId: admin.sub,
    tenantId: null,
    resourceId: null,
    action: 'tenant_delete',
    metadata: {
      targetTenantId: tenant.id,
      targetTenantName: tenant.name,
      usersDeleted,
      collectionsDeleted: exclusiveIds.length,
      collectionsSkippedShared: sharedIds.length,
      resourcesDeleted: exclusiveResources.length,
      invitationsDeleted,
      metadataFieldsDeleted,
      permissionOverridesDeleted,
    },
  });

  return NextResponse.json({
    ok: true,
    usersDeleted,
    collectionsDeleted: exclusiveIds.length,
    collectionsSkippedShared: sharedIds.length,
    resourcesDeleted: exclusiveResources.length,
  });
}
