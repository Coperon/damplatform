import bcrypt from 'bcryptjs';
import db from './db';
import { logAccess } from './accessLog';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShareRow {
  id: string;
  accessLevel: 'view' | 'download';
  expiresAt: string | null;
  collectionId: string | null;
  resourceId: string | null;
}

export type ShareValidation =
  | { status: 'valid'; share: ShareRow }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'revoked' };

// Splits "{shareId}.{rawToken}" on the first '.'. The id half is a uuid (never
// contains a dot); the token half is base64url (also never contains a dot),
// so this never misparses a well-formed link.
function parseShareParam(param: string): { id: string; rawToken: string } | null {
  const dotIndex = param.indexOf('.');
  if (dotIndex === -1) return null;
  const id = param.slice(0, dotIndex);
  const rawToken = param.slice(dotIndex + 1);
  if (!UUID_RE.test(id) || !rawToken) return null;
  return { id, rawToken };
}

// The single gate every public share endpoint must call first. Fails closed:
// any parse error, missing row, or bad token collapses to the same 'invalid'
// result as every other failure mode — there is no way for a caller to tell
// "no such share" apart from "wrong token for a real share."
export async function validateShareToken(param: string): Promise<ShareValidation> {
  const parsed = parseShareParam(param);
  if (!parsed) return { status: 'invalid' };

  const result = await db.query(
    `SELECT id, token_hash, access_level, expires_at, revoked, collection_id, resource_id
     FROM shares WHERE id = $1`,
    [parsed.id],
  );
  const row = result.rows[0];
  if (!row) return { status: 'invalid' };

  const matches = await bcrypt.compare(parsed.rawToken, row.token_hash);
  if (!matches) return { status: 'invalid' };

  if (row.revoked) return { status: 'revoked' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { status: 'expired' };

  return {
    status: 'valid',
    share: {
      id: row.id,
      accessLevel: row.access_level,
      expiresAt: row.expires_at,
      collectionId: row.collection_id,
      resourceId: row.resource_id,
    },
  };
}

export async function touchShareLastUsed(shareId: string): Promise<void> {
  await db.query('UPDATE shares SET last_used_at = now() WHERE id = $1', [shareId]);
}

// Best-effort attribution for anonymous share access (access_log's share_access
// event, which has no logged-in user/token to read a tenantId from). Resolves
// to the one tenant whose grant reaches the shared target — via the same
// any-depth tenant_collection_access cascade every other access check in this
// app uses (Stage 88), walked across every collection the target could be
// reached through, not just its immediate parent. Deliberately returns null
// (unresolvable, not a guess) whenever that isn't a single unambiguous
// tenant: zero grants (nobody's been given access to this, an odd but
// possible state for a share that still exists), or more than one tenant
// with a reaching grant (a shared resource/collection whose access has been
// extended to multiple tenants — attributing it to just one would misattribute
// activity to a tenant that doesn't actually own it).
export async function resolveShareOwningTenant(share: ShareRow): Promise<string | null> {
  if (share.resourceId) {
    const result = await db.query<{ tenant_id: string }>(
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
       SELECT DISTINCT cca.tenant_id
       FROM root_finder rf
       INNER JOIN tenant_collection_access cca ON cca.collection_id = rf.id`,
      [share.resourceId],
    );
    return result.rows.length === 1 ? result.rows[0].tenant_id : null;
  }
  if (share.collectionId) {
    const result = await db.query<{ tenant_id: string }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id FROM collections WHERE id = $1
         UNION ALL
         SELECT c.id, c.parent_id
         FROM collections c
         INNER JOIN ancestors a ON a.parent_id = c.id
       )
       SELECT DISTINCT cca.tenant_id
       FROM ancestors a
       INNER JOIN tenant_collection_access cca ON cca.collection_id = a.id`,
      [share.collectionId],
    );
    return result.rows.length === 1 ? result.rows[0].tenant_id : null;
  }
  return null;
}

// Fire-and-forget wrapper around the pair above — resolving the owning tenant
// is itself a real DB query that can fail independently of the eventual
// logAccess insert, so this wraps resolution + logging as one non-blocking
// unit: neither the resolution query's failure nor logAccess's own internal
// failure can ever reach (or delay) the caller. Callers must not await this.
export function logShareAccess(
  share: ShareRow,
  action: 'viewed' | 'downloaded',
  resourceId: string | null,
): void {
  resolveShareOwningTenant(share)
    .then((tenantId) => {
      logAccess({
        userId: null,
        tenantId,
        resourceId,
        action: 'share_access',
        metadata: { shareId: share.id, accessLevel: share.accessLevel, action },
      });
    })
    .catch((err) => {
      console.error('share_access logging failed', { shareId: share.id, action }, err);
    });
}

// Independent scope check for the file endpoint — never trust that a resourceId
// coming from a URL was actually part of the gallery this share exposed.
// Deliberately never joins group_collection_access or anything group-related:
// a share's scope is the collection's own subtree (or the one resource), full stop.
export async function isResourceInShareScope(share: ShareRow, resourceId: string): Promise<boolean> {
  if (share.resourceId) {
    return share.resourceId === resourceId;
  }
  if (share.collectionId) {
    const result = await db.query(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM collections WHERE id = $1
         UNION ALL
         SELECT c.id FROM collections c
         INNER JOIN subtree s ON c.parent_id = s.id
       )
       SELECT 1
       FROM collection_resource cr
       INNER JOIN subtree s ON s.id = cr.collection_id
       WHERE cr.resource_id = $2
       LIMIT 1`,
      [share.collectionId, resourceId],
    );
    return (result.rowCount ?? 0) > 0;
  }
  return false;
}
