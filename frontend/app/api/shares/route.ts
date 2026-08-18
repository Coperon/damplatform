import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, canAccessAllTenants, actingTenantId } from '@/lib/session';
import { encrypt } from '@/lib/crypto';
import { logAccess } from '@/lib/accessLog';
import {
  tenantHasCollectionAccess,
  tenantHasResourceAccess,
  requirePermission,
} from '@/lib/permissions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCESS_LEVELS = ['view', 'download'] as const;
type AccessLevel = (typeof ACCESS_LEVELS)[number];

const EXPIRY_OPTIONS = ['1d', '7d', '30d', 'never'] as const;
type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

// expiresIn is branch-selected here, never interpolated into SQL or used to build a string.
function computeExpiresAt(expiresIn: ExpiryOption): Date | null {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  if (expiresIn === '1d') return new Date(now + DAY);
  if (expiresIn === '7d') return new Date(now + 7 * DAY);
  if (expiresIn === '30d') return new Date(now + 30 * DAY);
  return null; // 'never'
}

interface Target {
  type: 'collection' | 'resource';
  id: string;
  name: string;
}

export async function POST(req: NextRequest) {
  // Stage 108: was requireAdmin — now the per-tenant 'create_share'
  // permission, independently configurable for editors and viewers (default
  // OFF for both — on disk this was requireAdmin-only, so this is a new
  // capability being made available, not a widened existing one). Resolved
  // against whichever role the caller actually has, via their own
  // tenant_role_permissions row — admin tiers stay unconditionally allowed.
  const user = await requirePermission(req, 'create_share');
  if (user instanceof Response) return user;

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

  const collectionId = typeof body.collectionId === 'string' ? body.collectionId : null;
  const resourceId = typeof body.resourceId === 'string' ? body.resourceId : null;

  if (Boolean(collectionId) === Boolean(resourceId)) {
    return NextResponse.json(
      { error: 'Provide exactly one of collectionId or resourceId' },
      { status: 400 },
    );
  }
  if (collectionId && !UUID_RE.test(collectionId)) {
    return NextResponse.json({ error: 'collectionId must be a valid uuid' }, { status: 400 });
  }
  if (resourceId && !UUID_RE.test(resourceId)) {
    return NextResponse.json({ error: 'resourceId must be a valid uuid' }, { status: 400 });
  }

  if (!isOneOf(body.accessLevel, ACCESS_LEVELS)) {
    return NextResponse.json(
      { error: `accessLevel must be one of: ${ACCESS_LEVELS.join(', ')}` },
      { status: 400 },
    );
  }
  const accessLevel: AccessLevel = body.accessLevel;

  if (!isOneOf(body.expiresIn, EXPIRY_OPTIONS)) {
    return NextResponse.json(
      { error: `expiresIn must be one of: ${EXPIRY_OPTIONS.join(', ')}` },
      { status: 400 },
    );
  }
  const expiresIn: ExpiryOption = body.expiresIn;

  const label =
    typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 255) : null;

  let target: Target;
  if (collectionId) {
    const lookup = await db.query('SELECT id, name FROM collections WHERE id = $1', [collectionId]);
    if (lookup.rowCount === 0) {
      return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
    }
    target = { type: 'collection', id: lookup.rows[0].id, name: lookup.rows[0].name };
  } else {
    const lookup = await db.query(
      'SELECT id, original_filename FROM resources WHERE id = $1',
      [resourceId],
    );
    if (lookup.rowCount === 0) {
      return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
    }
    target = { type: 'resource', id: lookup.rows[0].id, name: lookup.rows[0].original_filename };
  }

  // Tenant-scoped enforcement: a tenant admin may create a share only for
  // a target (collection or resource) their tenant can reach — cross-tenant
  // users (super admin, or role-2 + can_access_all_tenants) bypass this.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    const reachable =
      target.type === 'collection'
        ? await tenantHasCollectionAccess(user.tenantId, target.id)
        : await tenantHasResourceAccess(user.tenantId, target.id);
    if (!reachable) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  const expiresAt = computeExpiresAt(expiresIn);

  // Raw token is returned to the caller exactly once, in this response, and never
  // logged. It's persisted two ways: a bcrypt hash (token_hash) — the only thing
  // the public /api/share/[token] route ever checks against, unchanged — and,
  // additionally, AES-256-GCM-encrypted (token_encrypted) so an admin can later
  // re-copy the link via GET /api/shares/[id]/link. Encryption never substitutes
  // for the hash check; it's a second, separate at-rest copy for retrieval only.
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(rawToken, 10);

  // Computed before any DB write: if SHARE_TOKEN_KEY is missing/invalid, encrypt()
  // throws synchronously and the share is never partially created.
  let tokenEncrypted: string;
  try {
    tokenEncrypted = encrypt(rawToken);
  } catch (err) {
    console.error('Failed to encrypt share token:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'Server misconfiguration: share links cannot be created right now.' },
      { status: 500 },
    );
  }

  const insert = await db.query(
    `INSERT INTO shares (token_hash, token_encrypted, collection_id, resource_id, access_level, expires_at, created_by, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, access_level, expires_at, created_at`,
    [tokenHash, tokenEncrypted, collectionId, resourceId, accessLevel, expiresAt, user.sub, label],
  );
  const share = insert.rows[0];

  const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const url = `${baseUrl}/share/${share.id}.${rawToken}`;

  // Fire-and-forget — never the raw token, never awaited, never able to fail
  // the share creation itself. Only a share's own id/scope/access level/expiry
  // is recorded; the token that makes the link work is not derivable from any
  // of this.
  logAccess({
    userId: user.sub,
    tenantId: user.tenantId ?? null,
    resourceId: target.type === 'resource' ? target.id : null,
    action: 'share_create',
    metadata: {
      targetType: target.type,
      targetId: target.id,
      accessLevel,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    },
  });

  return NextResponse.json(
    {
      id: share.id,
      url,
      accessLevel: share.access_level,
      expiresAt: share.expires_at,
      target,
    },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const superAdmin = isSuperAdmin(user);

  // Neither token_hash nor token_encrypted is ever selected here — only whether
  // a retrievable link exists (hasLink). The encrypted blob itself is only ever
  // read by GET /api/shares/[id]/link, admin-only, one share at a time.
  const result = await db.query(
    `SELECT
       s.id,
       s.access_level,
       s.expires_at,
       s.created_at,
       s.last_used_at,
       s.revoked,
       s.label,
       (s.token_encrypted IS NOT NULL) AS has_link,
       c.id AS collection_id,
       c.name AS collection_name,
       r.id AS resource_id,
       r.original_filename AS resource_filename
     FROM shares s
     LEFT JOIN collections c ON c.id = s.collection_id
     LEFT JOIN resources r ON r.id = s.resource_id
     ORDER BY s.created_at DESC`,
  );

  // Tenant-scoped enforcement: `shares` has no tenant_id column (a share
  // targets a collection or resource, not a tenant), so filtering reuses the
  // same two cascade helpers every other newly-scoped route calls, once per
  // row — not a second, inline access path. A true super admin bypasses this
  // and sees every share, unfiltered, as before. A cross-tenant admin's list is
  // scoped to the tenant they're acting as (the switcher cookie, defaulting
  // to their own tenant) so the page reads as that tenant's view; a regular
  // tenant admin's actingTenantId is always just their own tenant.
  let rows = result.rows;
  if (!superAdmin) {
    const effectiveTenant = actingTenantId(user, req);
    if (!effectiveTenant) {
      rows = [];
    } else {
      const tenantId = effectiveTenant;
      const checks = await Promise.all(
        rows.map((row) =>
          row.collection_id
            ? tenantHasCollectionAccess(tenantId, row.collection_id)
            : tenantHasResourceAccess(tenantId, row.resource_id),
        ),
      );
      rows = rows.filter((_, i) => checks[i]);
    }
  }

  const shares = rows.map((row) => ({
    id: row.id,
    target: row.collection_id
      ? { type: 'collection' as const, id: row.collection_id, name: row.collection_name }
      : { type: 'resource' as const, id: row.resource_id, name: row.resource_filename },
    accessLevel: row.access_level,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revoked: row.revoked,
    label: row.label,
    hasLink: row.has_link,
  }));

  return NextResponse.json({ shares });
}
