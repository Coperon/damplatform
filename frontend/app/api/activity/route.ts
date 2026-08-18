import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, actingTenantId } from '@/lib/session';
import type { AccessAction } from '@/lib/accessLog';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelisted, matches lib/accessLog.ts's AccessAction union — kept as a
// runtime array here (the union itself is type-only) so an unrecognized
// ?action= value is simply dropped rather than 400ing, same convention as
// GET /api/media's type/sort whitelists.
const ALL_ACTIONS: AccessAction[] = [
  'view',
  'download',
  'share_create',
  'share_access',
  'upload',
  'login',
  'all_tenants_flag_change',
  'invite_flag_change',
  'user_delete',
  'tenant_delete',
];

// Same range convention as GET /api/analytics (kept as its own small copy —
// not worth a shared lib module for 15 lines used in two places).
const RANGE_DAYS: Record<string, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };
const DEFAULT_RANGE = '30d';
const PAGE_SIZE = 50;

function startOfRange(rangeDays: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (rangeDays - 1));
  return d;
}

interface Cursor {
  t: string;
  id: string;
}

// Opaque cursor = base64url(JSON{t: created_at ISO, id: uuid}) — decoded
// defensively; a malformed/tampered cursor just falls back to "no cursor"
// (start from the top) rather than 400ing, since this is an internal
// pagination detail the client never hand-constructs itself.
function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed.t === 'string' &&
      !Number.isNaN(Date.parse(parsed.t)) &&
      typeof parsed.id === 'string' &&
      UUID_RE.test(parsed.id)
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through to null
  }
  return null;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id })).toString('base64url');
}

interface Row {
  id: string;
  action: AccessAction;
  created_at: string;
  metadata: Record<string, unknown> | null;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  resource_id: string | null;
  resource_filename: string | null;
  upload_collection_name: string | null;
  share_target_collection_name: string | null;
  share_collection_id: string | null;
  share_collection_name: string | null;
}

export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { searchParams } = new URL(req.url);
  const superAdmin = isSuperAdmin(user);

  // Scope is always taken from the token, never the request — same discipline
  // as GET /api/analytics, GET /api/users, POST /api/invitations. A tenant
  // admin's own tenantId always wins; there is no request parameter that can
  // widen or redirect it (no ?tenantId= is even read for a tenant admin).
  // Fail closed: a tenant admin with no tenantId (old token, or a data
  // anomaly) gets an empty result rather than falling back to "see everyone."
  let tenantScope: string | null = null;
  if (!superAdmin) {
    // cross-tenant admins are scoped to the tenant they're acting as (the
    // switcher cookie, defaulting to their own tenant); regular tenant
    // admins to their own token tenantId (cookie silently ignored).
    const effectiveTenant = actingTenantId(user, req);
    if (!effectiveTenant) {
      return NextResponse.json({
        scope: { type: 'tenant', tenantId: null, tenantName: null },
        range: DEFAULT_RANGE,
        events: [],
        hasMore: false,
        nextCursor: null,
      });
    }
    tenantScope = effectiveTenant;
  }

  const rangeParam = searchParams.get('range') ?? DEFAULT_RANGE;
  const range = rangeParam in RANGE_DAYS ? rangeParam : DEFAULT_RANGE;
  const rangeDays = RANGE_DAYS[range];
  const since = rangeDays !== null ? startOfRange(rangeDays) : null;

  const requestedActions = searchParams
    .getAll('action')
    .filter((a): a is AccessAction => (ALL_ACTIONS as string[]).includes(a));

  // userId is validated (400 on malformed uuid) but never separately checked
  // against the caller's tenant — the al.tenant_id predicate below already
  // scopes the whole query, so a tenant admin passing another tenant's
  // userId simply matches zero rows (their own scope, not the other's),
  // never a leak and never a distinguishable error.
  const userIdParam = searchParams.get('userId');
  if (userIdParam !== null && !UUID_RE.test(userIdParam)) {
    return NextResponse.json({ error: 'userId must be a uuid' }, { status: 400 });
  }

  const cursorParam = searchParams.get('cursor');
  const cursor = cursorParam ? decodeCursor(cursorParam) : null;

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (tenantScope !== null) {
    params.push(tenantScope);
    clauses.push(`al.tenant_id = $${params.length}`);
  }
  if (since !== null) {
    params.push(since);
    clauses.push(`al.created_at >= $${params.length}`);
  }
  if (requestedActions.length > 0) {
    params.push(requestedActions);
    clauses.push(`al.action = ANY($${params.length})`);
  }
  if (userIdParam !== null) {
    params.push(userIdParam);
    clauses.push(`al.user_id = $${params.length}`);
  }
  if (cursor !== null) {
    params.push(cursor.t);
    const tIdx = params.length;
    params.push(cursor.id);
    const idIdx = params.length;
    clauses.push(`(al.created_at, al.id) < ($${tIdx}::timestamptz, $${idIdx}::uuid)`);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  // Fetch one extra row to know hasMore without a second COUNT query.
  params.push(PAGE_SIZE + 1);
  const limitIdx = params.length;

  const result = await db.query<Row>(
    `SELECT
       al.id, al.action, al.created_at, al.metadata,
       al.user_id, u.email AS user_email, u.name AS user_name,
       al.tenant_id, co.name AS tenant_name,
       al.resource_id, r.original_filename AS resource_filename,
       ucol.name AS upload_collection_name,
       tcol.name AS share_target_collection_name,
       sh.collection_id AS share_collection_id,
       shcol.name AS share_collection_name
     FROM access_log al
     LEFT JOIN users u ON u.id = al.user_id
     LEFT JOIN tenants co ON co.id = al.tenant_id
     LEFT JOIN resources r ON r.id = al.resource_id
     -- upload's collection, resolved from metadata.collectionId (nullable —
     -- Unassigned uploads have no collection to resolve).
     LEFT JOIN collections ucol
       ON al.action = 'upload' AND ucol.id = (al.metadata->>'collectionId')::uuid
     -- share_create's target when it's a collection (a resource target is
     -- already covered by the r join above, since resourceId = targetId for
     -- a resource-type share).
     LEFT JOIN collections tcol
       ON al.action = 'share_create' AND al.metadata->>'targetType' = 'collection'
      AND tcol.id = (al.metadata->>'targetId')::uuid
     -- share_access's own share row, only needed to resolve the shared
     -- collection's name for a 'viewed' event on a collection share (where
     -- al.resource_id is null by construction — see lib/shares.ts). A
     -- 'downloaded' event, or a 'viewed' event on a resource share, already
     -- has its target resolved via the r join above.
     LEFT JOIN shares sh
       ON al.action = 'share_access' AND sh.id = (al.metadata->>'shareId')::uuid
     LEFT JOIN collections shcol ON shcol.id = sh.collection_id
     ${whereSql}
     ORDER BY al.created_at DESC, al.id DESC
     LIMIT $${limitIdx}`,
    params,
  );

  const hasMore = result.rows.length > PAGE_SIZE;
  const pageRows = hasMore ? result.rows.slice(0, PAGE_SIZE) : result.rows;

  const scopeTenantName =
    tenantScope !== null
      ? ((await db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantScope])).rows[0]
          ?.name ?? null)
      : null;

  const events = pageRows.map((row) => {
    const metadata = row.metadata ?? {};

    const actor = { userId: row.user_id, name: row.user_name, email: row.user_email };
    // Raw, straight from the resource join — null whenever al.resource_id is
    // null, which happens for two entirely different reasons that look
    // identical at this column: (a) the action never carried one (login), or
    // (b) it did at write time but the resource has since been permanently
    // deleted (access_log.resource_id is ON DELETE SET NULL). Which one
    // applies depends on the action, resolved per-case below — never assume
    // "null resource_id" means "no resource" without checking that first.
    const rawResource = row.resource_id !== null ? { id: row.resource_id, filename: row.resource_filename } : null;

    let resource: { id: string | null; filename: string | null } | null = null;
    let target: { type: 'collection' | 'resource'; id: string | null; name: string | null } | null = null;
    let detail: Record<string, unknown> = {};

    switch (row.action) {
      case 'login':
        detail = { roleName: typeof metadata.roleName === 'string' ? metadata.roleName : null };
        break;
      case 'upload':
      case 'view':
      case 'download':
        // These three always log a real resourceId at write time (see
        // lib/accessLog.ts's call sites) — a null al.resource_id here can
        // only be the FK cascade from a later permanent delete, never "no
        // resource." Always surface the resource slot so it renders as
        // "(deleted asset)" instead of silently vanishing from the line.
        resource = rawResource ?? { id: null, filename: null };
        if (row.action === 'upload') {
          const collectionId = typeof metadata.collectionId === 'string' ? metadata.collectionId : null;
          detail = { collectionId, collectionName: collectionId ? row.upload_collection_name : null };
        } else if (row.action === 'view') {
          detail = { source: typeof metadata.source === 'string' ? metadata.source : null };
        }
        break;
      case 'share_create': {
        // Always described via `target`, even for a resource-type share —
        // `target.name` already falls back to null ("(deleted)") the same
        // way whether the resource was deleted or never existed to begin
        // with, so no separate resource-vs-deleted branch is needed here.
        const targetType: 'collection' | 'resource' = metadata.targetType === 'collection' ? 'collection' : 'resource';
        const targetId = typeof metadata.targetId === 'string' ? metadata.targetId : null;
        target = {
          type: targetType,
          id: targetId,
          name: targetType === 'resource' ? row.resource_filename : row.share_target_collection_name,
        };
        detail = {
          accessLevel: typeof metadata.accessLevel === 'string' ? metadata.accessLevel : null,
          expiresAt: typeof metadata.expiresAt === 'string' ? metadata.expiresAt : null,
        };
        break;
      }
      case 'share_access': {
        // Anonymous by construction (see lib/shares.ts::logShareAccess) — no
        // actor is ever attached here. Three cases for a null al.resource_id:
        // (a) a 'viewed' gallery-open on a collection share (by design — the
        // share's own collection, still resolvable via the sh/shcol join, is
        // the target); (b) a resource-type share whose resource has since
        // been deleted; (c) the share row itself has since been deleted too
        // (sh join also misses). (b) and (c) both surface as a deleted
        // asset rather than fabricating a collection that was never the
        // target — only (a), detected by a resolvable share_collection_id,
        // renders as a collection target.
        if (rawResource) {
          resource = rawResource;
        } else if (row.share_collection_id !== null) {
          target = { type: 'collection', id: row.share_collection_id, name: row.share_collection_name };
        } else {
          resource = { id: null, filename: null };
        }
        detail = {
          accessLevel: typeof metadata.accessLevel === 'string' ? metadata.accessLevel : null,
          shareAction: metadata.action === 'downloaded' ? 'downloaded' : 'viewed',
        };
        break;
      }
      case 'all_tenants_flag_change':
        // A super admin set/unset a user's can_access_all_tenants flag (PATCH
        // /api/users/[id]). The target's email/id come from write-time
        // metadata rather than a join — the flag event should keep saying
        // who it was about even if that user is later deleted.
        detail = {
          targetUserId: typeof metadata.targetUserId === 'string' ? metadata.targetUserId : null,
          targetEmail: typeof metadata.targetEmail === 'string' ? metadata.targetEmail : null,
          newValue: metadata.newValue === true,
        };
        break;
      case 'invite_flag_change':
        // Same shape as all_tenants_flag_change above, for users.can_invite.
        detail = {
          targetUserId: typeof metadata.targetUserId === 'string' ? metadata.targetUserId : null,
          targetEmail: typeof metadata.targetEmail === 'string' ? metadata.targetEmail : null,
          newValue: metadata.newValue === true,
        };
        break;
      case 'user_delete':
        // Same "describe the target from write-time metadata" shape as the
        // two flag-change actions above — the target row is gone by
        // construction (this is what the event records), so there is no
        // join to fall back on for any of these fields.
        detail = {
          targetUserId: typeof metadata.targetUserId === 'string' ? metadata.targetUserId : null,
          targetEmail: typeof metadata.targetEmail === 'string' ? metadata.targetEmail : null,
          targetName: typeof metadata.targetName === 'string' ? metadata.targetName : null,
          targetRoleId: typeof metadata.targetRoleId === 'number' ? metadata.targetRoleId : null,
        };
        break;
      case 'tenant_delete':
        // Same shape again — the tenant row (and every row that would
        // otherwise let this join resolve a name) is gone by construction,
        // so the deleted company's identity and every count come from
        // write-time metadata only.
        detail = {
          targetTenantId: typeof metadata.targetTenantId === 'string' ? metadata.targetTenantId : null,
          targetTenantName: typeof metadata.targetTenantName === 'string' ? metadata.targetTenantName : null,
          usersDeleted: typeof metadata.usersDeleted === 'number' ? metadata.usersDeleted : null,
          collectionsDeleted: typeof metadata.collectionsDeleted === 'number' ? metadata.collectionsDeleted : null,
          collectionsSkippedShared:
            typeof metadata.collectionsSkippedShared === 'number' ? metadata.collectionsSkippedShared : null,
          resourcesDeleted: typeof metadata.resourcesDeleted === 'number' ? metadata.resourcesDeleted : null,
        };
        break;
    }

    return {
      id: row.id,
      action: row.action,
      createdAt: row.created_at,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      actor,
      resource,
      target,
      detail,
    };
  });

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;

  return NextResponse.json({
    scope: {
      type: tenantScope !== null ? 'tenant' : 'all',
      tenantId: tenantScope,
      tenantName: scopeTenantName,
    },
    range,
    events,
    hasMore,
    nextCursor,
  });
}
