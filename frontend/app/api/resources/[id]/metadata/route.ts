import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAuth, canAccessAllTenants, actingTenantId } from '@/lib/session';
import { canEditResourceMetadata, hasPermission } from '@/lib/permissions';
import { logAccess } from '@/lib/accessLog';

const MAX_VALUE_LENGTH = 5000;

// Value encoding convention — every field_type still serializes to this single
// text column, so no storage or query change was needed to add richer types:
//   text | textarea -> the raw string, unchanged.
//   date            -> ISO "YYYY-MM-DD".
//   checkbox_group | tag -> the selected/entered values joined as
//     ", "-separated text (e.g. "Woman, Man"). A blank/empty selection clears
//     the field the same way an empty string does for text (row deleted, see
//     the PUT handler below) rather than storing "". This keeps
//     `value ILIKE '%q%'` in GET /api/search matching correctly against a
//     single value inside a comma-joined list (e.g. "Woman" matches
//     "Woman, Man").

interface MetadataRow {
  field_id: number;
  name: string;
  field_type: string;
  searchable: boolean;
  sort_order: number;
  options: string[] | null;
  required: boolean;
  value: string | null;
}

function shapeRows(rows: MetadataRow[]) {
  return rows.map((r) => ({
    fieldId: r.field_id,
    name: r.name,
    fieldType: r.field_type,
    searchable: r.searchable,
    sortOrder: r.sort_order,
    options: r.options,
    required: r.required,
    value: r.value,
  }));
}

// Field visibility rule (this stage): a viewer sees global field definitions
// (tenant_id IS NULL) plus their own tenant's — never another tenant's,
// regardless of which tenant happens to "own" the asset itself. A super
// admin (no tenant) sees global fields only here — the "manage every
// tenant's fields" privilege is specific to the admin page
// (GET /api/metadata-fields), not per-asset viewing/editing. Passing
// `tenantId` as the query param works for both cases with one predicate:
// `mf.tenant_id = NULL` is never true in SQL, so a null tenantId (super
// admin, or a fail-closed missing-tenant token) makes the OR collapse to
// exactly `mf.tenant_id IS NULL` on its own — no separate branch needed.
async function fetchMetadata(resourceId: string, tenantId: string | null) {
  const result = await db.query<MetadataRow>(
    `SELECT mf.id AS field_id, mf.name, mf.field_type, mf.searchable, mf.sort_order, mf.options, mf.required, rfd.value
     FROM metadata_fields mf
     LEFT JOIN resource_field_data rfd ON rfd.field_id = mf.id AND rfd.resource_id = $1
     WHERE mf.tenant_id IS NULL OR mf.tenant_id = $2
     ORDER BY (mf.tenant_id IS NOT NULL), mf.tenant_id, mf.sort_order, mf.id`,
    [resourceId, tenantId],
  );
  return shapeRows(result.rows);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  // Stage 108: reading an asset's metadata is now the per-tenant
  // 'view_metadata' permission (viewer-configurable; editors keep it
  // unconditionally as part of their baseline; admin tiers always true).
  // Was requireAuth-only before this stage. Checked before the resource
  // lookup so a permission-less viewer never even learns whether the id
  // exists.
  if (!(await hasPermission(user, 'view_metadata'))) {
    return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
  }

  const { id } = await ctx.params;

  const resourceCheck = await db.query('SELECT id FROM resources WHERE id = $1', [id]);
  if (resourceCheck.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Same resource-scoped cascade access check as GET /api/download/[id] — walk
  // every collection this file belongs to upward through parent_id and check
  // whether the user's tenant has access at any level in that chain, not just
  // the root (Stage 88: was root-only). A file in no accessible collection is
  // denied; this is the same isolation logic, not a new weaker check.
  // cross-tenant users (super admin, or role-2 + can_access_all_tenants) bypass this.
  // Fail closed: no tenant (old token, or a data anomaly) means no query, zero access.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    const accessCheck = await db.query(
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
      [id, user.tenantId],
    );
    if (accessCheck.rowCount === 0) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  // View signal: this is the single server-side call fired whenever a user
  // opens one specific asset's details — the MetadataDrawer (all roles) or
  // the full-page metadata editor, both keyed by resourceId so opening a
  // different asset forces a fresh mount/fetch. It never fires for a grid or
  // list of cards merely rendering. Fire-and-forget, not awaited — never
  // affects this response. Only reached past the access check above, so a
  // denied attempt is never logged as activity. A second, independent 'view'
  // signal was later added for lightbox opens (POST /api/resources/[id]/view)
  // — both are kept (never triggered by the same click, so never a double
  // count of one look) and tagged by source so the two stay distinguishable.
  logAccess({
    userId: user.sub,
    tenantId: user.tenantId ?? null,
    resourceId: id,
    action: 'view',
    metadata: { source: 'metadata' },
  });

  // Field scope follows the acting tenant: a cross-tenant admin navigating as
  // tenant B sees global + B's fields, exactly what a member of B would see;
  // everyone else's actingTenantId is just their own tenant (or null for a
  // super admin → global-only, unchanged).
  return NextResponse.json(await fetchMetadata(id, actingTenantId(user, req)));
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

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

  if (!Array.isArray(body.values)) {
    return NextResponse.json({ error: 'values must be an array' }, { status: 400 });
  }

  const entries: { fieldId: number; value: string | null }[] = [];
  for (const raw of body.values) {
    if (typeof raw !== 'object' || raw === null) {
      return NextResponse.json({ error: 'Each value entry must be an object' }, { status: 400 });
    }
    const { fieldId, value } = raw as Record<string, unknown>;
    if (typeof fieldId !== 'number' || !Number.isInteger(fieldId)) {
      return NextResponse.json({ error: 'fieldId must be an integer' }, { status: 400 });
    }
    if (value !== null && value !== undefined && typeof value !== 'string') {
      return NextResponse.json({ error: 'value must be a string or null' }, { status: 400 });
    }
    if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
      return NextResponse.json(
        { error: `value must be ${MAX_VALUE_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }
    entries.push({ fieldId, value: typeof value === 'string' ? value : null });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const resourceCheck = await client.query('SELECT id FROM resources WHERE id = $1', [id]);
    if (resourceCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Admin: unrestricted. Editor: only if this resource is in a collection
    // their group can reach (same scope check as the metadata page's own
    // gate and GET /api/resources/[id]). Everyone else: denied.
    if (!(await canEditResourceMetadata(user, id))) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (entries.length > 0) {
      // Reject the whole request if any fieldId doesn't correspond to a
      // field visible to this caller (global, or their own tenant — the
      // same scope as fetchMetadata above), rather than silently skipping it
      // — keeps the write atomic and honest about what was actually saved.
      // This also closes a would-be gap: without the scope filter here, a
      // caller in scope for this resource could still write a value for
      // some other tenant's field id by guessing/enumerating it, even
      // though they'd never see that field in a GET.
      const fieldIds = entries.map((e) => e.fieldId);
      const validFields = await client.query<{ id: number }>(
        'SELECT id FROM metadata_fields WHERE id = ANY($1::int[]) AND (tenant_id IS NULL OR tenant_id = $2)',
        [fieldIds, actingTenantId(user, req)],
      );
      const validIds = new Set(validFields.rows.map((r) => r.id));
      const unknown = fieldIds.filter((fid) => !validIds.has(fid));
      if (unknown.length > 0) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: `Unknown field id(s): ${unknown.join(', ')}` },
          { status: 400 },
        );
      }

      for (const entry of entries) {
        const trimmed = (entry.value ?? '').trim();
        if (trimmed === '') {
          // Clearing a field removes the row rather than storing an empty string.
          await client.query(
            'DELETE FROM resource_field_data WHERE resource_id = $1 AND field_id = $2',
            [id, entry.fieldId],
          );
        } else {
          await client.query(
            `INSERT INTO resource_field_data (resource_id, field_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (resource_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
            [id, entry.fieldId, trimmed],
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return NextResponse.json(await fetchMetadata(id, actingTenantId(user, req)));
}
