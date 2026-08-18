import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { validateShareToken, touchShareLastUsed, logShareAccess } from '@/lib/shares';

interface FileSummary {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  hasThumbnail: boolean;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const validation = await validateShareToken(token);

  if (validation.status !== 'valid') {
    // Same shape (and same 404) for 'invalid' whether the id doesn't exist or the
    // token is wrong for a real id — no oracle. 'expired'/'revoked' get their own,
    // non-sensitive status so the page can show a clearer message.
    const httpStatus = validation.status === 'invalid' ? 404 : 410;
    return NextResponse.json({ status: validation.status }, { status: httpStatus });
  }

  const { share } = validation;
  await touchShareLastUsed(share.id);

  // "The link was opened" — fires once per gallery load, not per file/thumbnail
  // (those are served by the file route below and are never logged for a plain
  // preview, only for an actual download — see that route). The accessor is
  // anonymous by design (no login on this path), so user_id is null; tenant
  // is attributed only when exactly one tenant's grant reaches the shared
  // target (see resolveShareOwningTenant's own doc comment for why an
  // ambiguous/ungranted target logs with tenant_id: null instead of guessing).
  // Not awaited — logShareAccess is fire-and-forget end to end.
  logShareAccess(share, 'viewed', share.resourceId);

  let target: { type: 'collection' | 'resource'; name: string };
  let files: FileSummary[];

  if (share.collectionId) {
    const collLookup = await db.query('SELECT name FROM collections WHERE id = $1', [share.collectionId]);
    if (collLookup.rowCount === 0) {
      // ON DELETE CASCADE means this share row shouldn't outlive its collection,
      // but fail closed regardless of how that invariant could be violated.
      return NextResponse.json({ status: 'invalid' }, { status: 404 });
    }
    target = { type: 'collection', name: collLookup.rows[0].name };

    // Downward-only recursive CTE from the shared collection to its descendants.
    // Deliberately no join to group_collection_access anywhere — scope here is
    // purely structural (this collection's subtree), not the group model.
    const result = await db.query(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM collections WHERE id = $1
         UNION ALL
         SELECT c.id FROM collections c
         INNER JOIN subtree s ON c.parent_id = s.id
       )
       SELECT DISTINCT r.id, r.original_filename, r.mime_type, r.size_bytes, r.thumbnail_storage_key, r.created_at
       FROM resources r
       INNER JOIN collection_resource cr ON cr.resource_id = r.id
       INNER JOIN subtree s ON s.id = cr.collection_id
       ORDER BY r.created_at DESC`,
      [share.collectionId],
    );
    files = result.rows.map((r) => ({
      id: r.id,
      original_filename: r.original_filename,
      mime_type: r.mime_type,
      size_bytes: Number(r.size_bytes),
      hasThumbnail: Boolean(r.thumbnail_storage_key),
    }));
  } else {
    const result = await db.query(
      'SELECT id, original_filename, mime_type, size_bytes, thumbnail_storage_key FROM resources WHERE id = $1',
      [share.resourceId],
    );
    const r = result.rows[0];
    if (!r) {
      return NextResponse.json({ status: 'invalid' }, { status: 404 });
    }
    target = { type: 'resource', name: r.original_filename };
    files = [{
      id: r.id,
      original_filename: r.original_filename,
      mime_type: r.mime_type,
      size_bytes: Number(r.size_bytes),
      hasThumbnail: Boolean(r.thumbnail_storage_key),
    }];
  }

  return NextResponse.json({
    status: 'valid',
    accessLevel: share.accessLevel,
    expiresAt: share.expiresAt,
    target,
    files,
  });
}
