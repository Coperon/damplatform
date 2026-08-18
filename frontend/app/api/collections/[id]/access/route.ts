import { NextRequest, NextResponse } from 'next/server';
import type { Pool, PoolClient } from 'pg';
import db from '@/lib/db';
import { requireAdmin, canAccessAllTenants } from '@/lib/session';
import { tenantHasCollectionAccess, TENANT_ADMIN_CAN_EDIT_ACCESS } from '@/lib/permissions';

// Tenants eligible to be granted collection access — every row in the table.
// Unlike the old group model, there's no "Pending"-equivalent tenant to
// exclude here; every row is a real tenant.
const TENANTS_SQL = `SELECT id, name FROM tenants ORDER BY name`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Executor = Pool | PoolClient;

// Stage 88: grants are valid at any depth and cascade downward — a collection
// no longer needs to be a root to carry its own grant. This route used to
// resolve every request to its root collection and reject non-root writes
// with a 400 (`resolveRoot`/`isRoot`, removed); it now reads and writes the
// requested collection's own `tenant_collection_access` rows directly.

async function collectionExists(executor: Executor, collectionId: string): Promise<boolean> {
  const result = await executor.query('SELECT 1 FROM collections WHERE id = $1', [collectionId]);
  return (result.rowCount ?? 0) > 0;
}

// For context only (never edited by this route): for each tenant with no own
// grant on `collectionId`, the nearest strict ancestor (smallest depth above
// this collection) that grants it, if any. Lets the modal show "also
// accessible via Products" without claiming that ancestor's grant is this
// collection's own — the editable set is always this collection's own rows.
async function fetchNearestGrantingAncestor(
  executor: Executor,
  collectionId: string,
): Promise<Map<string, { id: string; name: string }>> {
  const result = await executor.query<{ tenant_id: string; ancestor_id: string; ancestor_name: string }>(
    `WITH RECURSIVE ancestor_chain AS (
       SELECT id, name, parent_id, 0 AS depth FROM collections WHERE id = $1
       UNION ALL
       SELECT c.id, c.name, c.parent_id, ac.depth + 1
       FROM collections c
       INNER JOIN ancestor_chain ac ON ac.parent_id = c.id
     )
     SELECT DISTINCT ON (cca.tenant_id)
       cca.tenant_id, ac.id AS ancestor_id, ac.name AS ancestor_name
     FROM ancestor_chain ac
     INNER JOIN tenant_collection_access cca ON cca.collection_id = ac.id
     WHERE ac.depth >= 1
     ORDER BY cca.tenant_id, ac.depth ASC`,
    [collectionId],
  );
  const map = new Map<string, { id: string; name: string }>();
  for (const row of result.rows) {
    map.set(row.tenant_id, { id: row.ancestor_id, name: row.ancestor_name });
  }
  return map;
}

async function fetchTenantsWithGrantState(executor: Executor, collectionId: string) {
  const [tenants, granted, inherited] = await Promise.all([
    executor.query<{ id: string; name: string }>(TENANTS_SQL),
    executor.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenant_collection_access WHERE collection_id = $1',
      [collectionId],
    ),
    fetchNearestGrantingAncestor(executor, collectionId),
  ]);
  const grantedIds = new Set(granted.rows.map((r) => r.tenant_id));
  return tenants.rows.map((c) => ({
    id: c.id,
    name: c.name,
    granted: grantedIds.has(c.id),
    // Only set when there's no own grant — context for an otherwise-ungranted
    // tenant that can still see this collection via an ancestor.
    inheritedFrom: grantedIds.has(c.id) ? null : inherited.get(c.id) ?? null,
  }));
}

// Tenant-admin view: the exact same shape as fetchTenantsWithGrantState's
// per-tenant object, but computed for (and returned as a single-element
// array containing only) the caller's own tenant — never the full
// TENANTS_SQL list, so another tenant's name/grant state is never even
// queried into a response a tenant admin could see. This is what makes
// "other tenants' rows are not shown" true at the query level, not just
// via response filtering.
async function fetchOwnTenantGrantState(executor: Executor, collectionId: string, tenantId: string) {
  const [tenantRow, granted, inherited] = await Promise.all([
    executor.query<{ id: string; name: string }>('SELECT id, name FROM tenants WHERE id = $1', [tenantId]),
    executor.query(
      'SELECT 1 FROM tenant_collection_access WHERE collection_id = $1 AND tenant_id = $2',
      [collectionId, tenantId],
    ),
    fetchNearestGrantingAncestor(executor, collectionId),
  ]);
  const tenant = tenantRow.rows[0];
  if (!tenant) return [];
  const isGranted = (granted.rowCount ?? 0) > 0;
  return [
    {
      id: tenant.id,
      name: tenant.name,
      granted: isGranted,
      inheritedFrom: isGranted ? null : inherited.get(tenant.id) ?? null,
    },
  ];
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  // Access editing is not on the cross-tenant-access exceptions list (invite
  // / create tenant / set can_access_all_tenants / global metadata
  // definitions), so an admin with cross-tenant access gets the full
  // super-admin view here — every tenant's grant state.
  const fullAccess = canAccessAllTenants(user);

  if (!(await collectionExists(db, id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!fullAccess) {
    // Interim-decision gate: one flip in lib/permissions.ts reverts every
    // tenant admin back to super-admin-only here, no route edits needed.
    if (!TENANT_ADMIN_CAN_EDIT_ACCESS) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    // Self-granting guard, part 1: a tenant admin may only open this on a
    // collection their own tenant can already reach — never an arbitrary id.
    if (!user.tenantId || !(await tenantHasCollectionAccess(user.tenantId, id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    const tenants = await fetchOwnTenantGrantState(db, id, user.tenantId);
    return NextResponse.json({ collectionId: id, tenants });
  }

  const tenants = await fetchTenantsWithGrantState(db, id);

  return NextResponse.json({ collectionId: id, tenants });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  // Same rule as GET above: cross-tenant admins get the super admin's whole-set
  // replace, not the own-row-only tenant-admin path.
  const fullAccess = canAccessAllTenants(user);

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

  const { tenantIds } = body;
  if (!Array.isArray(tenantIds) || !tenantIds.every((c) => typeof c === 'string' && UUID_RE.test(c))) {
    return NextResponse.json({ error: 'tenantIds must be an array of uuids' }, { status: 400 });
  }
  const requestedIds = [...new Set(tenantIds as string[])];

  if (!fullAccess) {
    // Self-granting guard, part 2 (the one that actually matters): a tenant
    // admin may edit access on a collection their tenant can reach, and may
    // toggle ONLY their own tenant's row. Any other id in the request —
    // granting or revoking a tenant that isn't theirs — is rejected outright
    // rather than silently dropped, so a tenant admin gets a clear signal
    // instead of a request that appeared to succeed but did less than asked.
    if (!TENANT_ADMIN_CAN_EDIT_ACCESS) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    if (!user.tenantId || !(await tenantHasCollectionAccess(user.tenantId, id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    const foreign = requestedIds.filter((cid) => cid !== user.tenantId);
    if (foreign.length > 0) {
      return NextResponse.json(
        { error: 'You may only grant or revoke your own company’s access' },
        { status: 403 },
      );
    }

    // Deliberately NOT the super admin's whole-set replace below: that would
    // delete every OTHER tenant's grant on this collection too, which is
    // exactly the cross-tenant write this guard exists to prevent. This only
    // ever touches this collection's own-tenant row.
    const grantOwn = requestedIds.includes(user.tenantId);
    if (grantOwn) {
      await db.query(
        `INSERT INTO tenant_collection_access (tenant_id, collection_id) VALUES ($1, $2)
         ON CONFLICT (tenant_id, collection_id) DO NOTHING`,
        [user.tenantId, id],
      );
    } else {
      await db.query(
        'DELETE FROM tenant_collection_access WHERE collection_id = $1 AND tenant_id = $2',
        [id, user.tenantId],
      );
    }

    const tenants = await fetchOwnTenantGrantState(db, id, user.tenantId);
    return NextResponse.json({ collectionId: id, tenants });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (!(await collectionExists(client, id))) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const validTenants = await client.query<{ id: string }>(TENANTS_SQL);
    const validIds = new Set(validTenants.rows.map((r) => r.id));
    const invalid = requestedIds.filter((cid) => !validIds.has(cid));
    if (invalid.length > 0) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Unknown company id(s): ${invalid.join(', ')}` },
        { status: 400 },
      );
    }

    // Whole-set replace in one transaction: drop every existing grant on this
    // exact collection that's not in the new set, then add every one that's
    // missing (ON CONFLICT DO NOTHING makes re-granting an already-granted
    // tenant a no-op). This deliberately allows requestedIds to be empty —
    // removing every tenant's own grant here is a valid, intentional action;
    // admin access is gated entirely by the JWT's own `canAdmin` claim (see
    // lib/session.ts's requireAdmin), never by a tenant_collection_access row,
    // so clearing every grant can never lock an admin out. A tenant may still
    // see this collection afterward via an ancestor's own grant (Stage 88's
    // cascade) — that's inheritance, not this route's concern; it edits only
    // this collection's own rows.
    await client.query(
      `DELETE FROM tenant_collection_access
       WHERE collection_id = $1 AND NOT (tenant_id = ANY($2::uuid[]))`,
      [id, requestedIds],
    );
    for (const tenantId of requestedIds) {
      await client.query(
        `INSERT INTO tenant_collection_access (tenant_id, collection_id) VALUES ($1, $2)
         ON CONFLICT (tenant_id, collection_id) DO NOTHING`,
        [tenantId, id],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const tenants = await fetchTenantsWithGrantState(db, id);
  return NextResponse.json({ collectionId: id, tenants });
}
