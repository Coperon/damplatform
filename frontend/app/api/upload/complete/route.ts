import { isSuperAdmin, canAccessAllTenants } from '@/lib/session';
import { AppError } from '@/lib/errors';
import { resolveUniqueFilename } from '@/lib/filenames';
import { getObject } from '@/lib/storage';
import { applyExtractedMetadata } from '@/lib/exif';
import { logAccess } from '@/lib/accessLog';
import { requirePermission } from '@/lib/permissions';
import db from '@/lib/db';

// Pulls the just-uploaded bytes back from MinIO and writes any mapped
// EXIF/IPTC/XMP values into resource_field_data before the upload response
// returns - this has to happen inline (not fire-and-forget) because the
// Save-and-next metadata workflow the caller redirects into next reads
// straight from the DB, and would render an empty form if extraction were
// still in flight. Errors are swallowed here too (not just inside
// applyExtractedMetadata) since a getObject failure is no more the upload's
// problem than a bad EXIF block is.
// Pulls the just-uploaded image back out of object storage to read its EXIF,
// so this route's wall-clock is a storage round-trip on top of the inserts.
// The platform default (often 10-15s on serverless) is not enough headroom
// for a large image on a cold instance.
export const maxDuration = 60;

// The RETURNING list shared by both INSERT branches below. Named so the row
// can be declared before the transaction's try block and used after it — see
// the deadlock note at the first COMMIT.
type NewResourceRow = {
  id: string;
  original_filename: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
};

async function extractMetadataInline(
  resourceId: string,
  storageKey: string,
  contentType: string,
  uploaderTenantId: string | null,
) {
  if (!contentType.startsWith('image/')) return;
  try {
    const bytes = await getObject(storageKey);
    await applyExtractedMetadata(resourceId, bytes, contentType, uploaderTenantId);
  } catch (err) {
    console.error('upload/complete: metadata extraction failed, ignoring:', err);
  }
}

export async function POST(request: Request) {
  // Stage 108: was requireUpload (role-derived canUpload) — now the
  // per-tenant 'upload' permission, resolved from the DB per request.
  const user = await requirePermission(request, 'upload');
  if (user instanceof Response) return user;

  try {
    const body = await request.json();
    if (!body.key || !body.filename || !body.contentType || body.size == null) {
      return Response.json(
        { message: 'key, filename, contentType and size are required' },
        { status: 400 },
      );
    }

    const { collectionId } = body;

    // Tenant-admin enforcement: an unassigned resource sits in no collection
    // at all, so it's outside every tenant's reach (Stage 101's GET /api/media
    // scoping) — invisible in a tenant admin's own media library, reachable
    // only by a super admin from then on. A tenant admin (canAdmin, but not a
    // true super admin) must always target a collection; a true super admin
    // may still create Unassigned resources deliberately, unchanged. Editors
    // are not required here — their only upload surface (the collection
    // detail page) already always sends a collectionId, so this would never
    // fire for them in practice, and narrowing it to tenant admins only
    // matches this stage's scope exactly.
    if (collectionId == null && user.canAdmin && !isSuperAdmin(user)) {
      return Response.json(
        { message: 'Choose a collection for this upload' },
        { status: 400 },
      );
    }

    if (collectionId != null) {
      if (typeof collectionId !== 'string') {
        return Response.json({ message: 'collectionId must be a string' }, { status: 400 });
      }

      const colCheck = await db.query('SELECT id FROM collections WHERE id = $1', [collectionId]);
      if (colCheck.rowCount === 0) {
        return Response.json({ message: 'Collection not found' }, { status: 404 });
      }

      // Cascade ancestor access check — a grant matches at any level in the
      // chain (Stage 88: was root-only). Walk from the target collection
      // upward through parent_id and verify any ancestor (inclusive) is granted
      // to the user's tenant. cross-tenant users (super admin, or role-2 +
      // can_access_all_tenants) bypass this; the choose-a-collection rule above still
      // applies to cross-tenant admins, since an unassigned resource would be
      // invisible in their tenant-scoped media view too.
      // Fail closed: no tenant (old token, or a data anomaly) means no query, zero access.
      if (!canAccessAllTenants(user)) {
        if (!user.tenantId) {
          return Response.json({ message: 'Access to collection denied' }, { status: 403 });
        }
        const accessCheck = await db.query(
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
          [collectionId, user.tenantId],
        );
        if (accessCheck.rowCount === 0) {
          return Response.json({ message: 'Access to collection denied' }, { status: 403 });
        }
      }

      const client = await db.connect();
      let resource!: NewResourceRow;
      try {
        await client.query('BEGIN');

        // Dedupe against files already in this collection, checked on the same
        // transaction client right before the insert (see filenames.ts for the
        // scoping query and the residual TOCTOU note).
        const filename = await resolveUniqueFilename(client, collectionId, body.filename);

        const result = await client.query(
          `INSERT INTO resources
             (original_filename, storage_key, mime_type, size_bytes, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, original_filename, storage_key, mime_type, size_bytes, status, created_at`,
          [filename, body.key, body.contentType, body.size, user.sub],
        );
        resource = result.rows[0];
        await client.query(
          'INSERT INTO collection_resource (collection_id, resource_id) VALUES ($1, $2)',
          [collectionId, resource.id],
        );

        // Auto-cover: first image uploaded into a coverless collection becomes its cover.
        // Conditional WHERE (not read-then-write) so concurrent uploads can't race, and so
        // this can never clobber a manually-set or already-auto-set cover.
        if (typeof body.contentType === 'string' && body.contentType.startsWith('image/')) {
          await client.query(
            'UPDATE collections SET cover_storage_key = $1 WHERE id = $2 AND cover_storage_key IS NULL',
            [resource.storage_key, collectionId],
          );

          // Propagate the same cover up to any coverless ancestor collections —
          // a container collection (one holding only sub-collections, no direct
          // files) can never get a cover from its own member scan, so this is
          // what lets uploading into e.g. ghidini/2026/shoot also give ghidini
          // a cover if it lacked one. One recursive CTE (same shape as the
          // access-check root_finder above) + one guarded UPDATE — not a loop of
          // round-trips. The NULL-guard means an ancestor with an existing
          // (manual or automatic) cover is never touched, at any level.
          await client.query(
            `WITH RECURSIVE ancestors AS (
               SELECT id, parent_id FROM collections WHERE id = $2
               UNION ALL
               SELECT c.id, c.parent_id
               FROM collections c
               INNER JOIN ancestors a ON a.parent_id = c.id
               WHERE a.parent_id IS NOT NULL
             )
             UPDATE collections
                SET cover_storage_key = $1
              WHERE id IN (SELECT id FROM ancestors WHERE id <> $2)
                AND cover_storage_key IS NULL`,
            [resource.storage_key, collectionId],
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Both of these go through the shared pool and therefore need their own
      // connection, so they must run AFTER client.release(), never before it.
      // Inside the try they deadlock a small pool: the transaction client is
      // still checked out, the awaited extractMetadataInline waits for a
      // second connection that only client.release() can free, and
      // client.release() is in a finally that the await never reaches. With
      // PG_POOL_MAX=1 (the serverless setting — see lib/db.ts) that hangs
      // every upload permanently. Same ordering rule, and the same reason, as
      // POST /api/invitations/redeem's post-COMMIT mint.
      //
      // Fire-and-forget — mirrors the point where the client fires its own
      // fire-and-forget thumbnail-generation request, right after this same
      // 201 lands.
      logAccess({
        userId: user.sub,
        tenantId: user.tenantId ?? null,
        resourceId: resource.id,
        action: 'upload',
        metadata: { filename: resource.original_filename, collectionId },
      });
      await extractMetadataInline(resource.id, resource.storage_key, resource.mime_type, user.tenantId ?? null);
      return Response.json(resource, { status: 201 });
    }

    // No collectionId — dedupe against the Unassigned set, then insert.
    const client = await db.connect();
    let resource!: NewResourceRow;
    try {
      await client.query('BEGIN');
      const filename = await resolveUniqueFilename(client, null, body.filename);
      const result = await client.query(
        `INSERT INTO resources
           (original_filename, storage_key, mime_type, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, original_filename, storage_key, mime_type, size_bytes, status, created_at`,
        [filename, body.key, body.contentType, body.size, user.sub],
      );
      await client.query('COMMIT');
      resource = result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // After client.release(), for the deadlock reason documented above.
    logAccess({
      userId: user.sub,
      tenantId: user.tenantId ?? null,
      resourceId: resource.id,
      action: 'upload',
      metadata: { filename: resource.original_filename, collectionId: null },
    });
    await extractMetadataInline(resource.id, resource.storage_key, resource.mime_type, user.tenantId ?? null);
    return Response.json(resource, { status: 201 });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
