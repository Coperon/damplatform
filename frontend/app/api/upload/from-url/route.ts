import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { isSuperAdmin, canAccessAllTenants } from '@/lib/session';
import { AppError } from '@/lib/errors';
import { putObject } from '@/lib/storage';
import { resolveUniqueFilename } from '@/lib/filenames';
import { applyExtractedMetadata } from '@/lib/exif';
import { logAccess } from '@/lib/accessLog';
import { tenantHasCollectionAccess, requirePermission } from '@/lib/permissions';
import db from '@/lib/db';

// The image bytes are already in memory from the fetch above - no need for a
// redundant getObject round-trip to MinIO the way upload/complete needs one.
// Same inline-not-fire-and-forget reasoning as there: the Save-and-next
// workflow reads resource_field_data immediately after this responds.
// This route fetches a remote file server-side (bounded to 15 MB and a 10s
// per-hop fetch timeout, up to MAX_REDIRECTS hops), uploads it to object
// storage, then reads its EXIF — several network round-trips in one request,
// well past a serverless platform's short default.
export const maxDuration = 60;

// The RETURNING list shared by both INSERT branches below. Declared as a type
// so the row can be hoisted out of the transaction's try block and used after
// client.release() — see the deadlock note at the first COMMIT.
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
  buffer: Buffer,
  contentType: string,
  uploaderTenantId: string | null,
) {
  try {
    await applyExtractedMetadata(resourceId, buffer, contentType, uploaderTenantId);
  } catch (err) {
    console.error('upload/from-url: metadata extraction failed, ignoring:', err);
  }
}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_URL_LENGTH = 2048;

// Only these are accepted — deliberately excludes image/svg+xml (XML, can
// carry scripts) and anything else. Extension is derived from this map, not
// from the URL or from the server's filename, since content-type is the one
// thing we've actually verified.
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// Used for every rejection that stems from URL/IP validation. Never made
// more specific than this — the caller must not learn which check failed or
// what address a hostname resolved to.
const URL_NOT_ALLOWED = 'URL not allowed';

interface ValidatedTarget {
  url: URL;
  pinnedAddress: string;
  pinnedFamily: number;
}

/**
 * Guardrails 1 + 2: parse the URL, restrict to http/https, resolve the
 * hostname via DNS, and reject if *any* resolved address is not a plain
 * public unicast address (this is an allow-list, not a deny-list — anything
 * that isn't ordinary public unicast is rejected, which covers loopback,
 * private ranges, link-local/cloud-metadata, unique-local IPv6, unspecified,
 * reserved, multicast, and IPv4-mapped IPv6 addresses in one check).
 *
 * Returns one of the validated addresses so the caller can pin the actual
 * TCP connection to it — the connection must NOT re-resolve the hostname,
 * or a DNS-rebinding attacker could serve a safe address here and a private
 * one at connect time (TOCTOU).
 */
async function validateUrl(rawUrl: string): Promise<ValidatedTarget> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    throw new AppError(400, 'Invalid URL');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, URL_NOT_ALLOWED);
  }

  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(400, URL_NOT_ALLOWED);
  }

  if (addresses.length === 0) {
    throw new AppError(400, URL_NOT_ALLOWED);
  }

  for (const { address } of addresses) {
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsed = ipaddr.parse(address);
    } catch {
      throw new AppError(400, URL_NOT_ALLOWED);
    }
    if (parsed.range() !== 'unicast') {
      throw new AppError(400, URL_NOT_ALLOWED);
    }
  }

  const chosen = addresses[0];
  return { url, pinnedAddress: chosen.address, pinnedFamily: chosen.family };
}

// A `lookup` override that ignores whatever hostname it's asked to resolve
// and always hands back the single address we already validated. This is
// what actually pins the connection — without it, http/https would run its
// own fresh DNS lookup at connect time, reopening the rebinding gap that
// validateUrl() exists to close.
function pinnedLookup(address: string, family: number) {
  return (
    _hostname: string,
    options: { all?: boolean } | ((...args: unknown[]) => void),
    callback?: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    // Node may call lookup as (hostname, callback) or (hostname, options, callback)
    const opts = typeof options === 'function' ? {} : options;
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;

    if (opts && (opts as { all?: boolean }).all) {
      // all:true → callback expects an array of {address, family}
      cb(null, [{ address, family }]);
    } else {
      // single form → (err, address, family)
      cb(null, address, family);
    }
  };
}

type FetchResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'ok'; buffer: Buffer; contentType: string };

function fetchOnce(target: ValidatedTarget): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const { url, pinnedAddress, pinnedFamily } = target;
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Accept: 'image/*',
          'User-Agent': 'DAMPlatform-URLImport/1.0',
        },
        lookup: pinnedLookup(pinnedAddress, pinnedFamily),
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        // Redirects are never followed automatically — the caller re-runs
        // full scheme + DNS/IP validation on the target before another
        // request is made (see importImage()'s loop).
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.resume();
          if (!location) {
            reject(new AppError(400, 'Could not fetch the URL'));
            return;
          }
          resolve({ kind: 'redirect', location });
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new AppError(400, 'Could not fetch the URL'));
          return;
        }

        const contentType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, contentType)) {
          res.resume();
          reject(new AppError(400, 'URL did not point to a supported image type'));
          return;
        }

        const declaredLength = Number(res.headers['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
          res.resume();
          reject(new AppError(400, 'Image exceeds the maximum allowed size'));
          return;
        }

        // Content-Length can be absent or simply wrong, so the real cap is
        // enforced here as bytes actually arrive, not just on the header.
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;

        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          total += chunk.length;
          if (total > MAX_BYTES) {
            aborted = true;
            res.destroy();
            reject(new AppError(400, 'Image exceeds the maximum allowed size'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (aborted) return;
          resolve({ kind: 'ok', buffer: Buffer.concat(chunks), contentType });
        });

        res.on('error', () => {
          if (aborted) return;
          reject(new AppError(400, 'Could not fetch the URL'));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', () => {
      reject(new AppError(400, 'Could not fetch the URL'));
    });

    req.end();
  });
}

/**
 * Full guarded fetch: validate -> fetch -> if redirected, re-validate the
 * redirect target from scratch (scheme + DNS/IP checks apply again, so a
 * redirect can't be used to smuggle a request to a blocked address) -> fetch
 * again, up to MAX_REDIRECTS hops.
 */
async function importImage(initialUrl: string): Promise<{ buffer: Buffer; contentType: string; finalUrl: URL }> {
  let target = await validateUrl(initialUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await fetchOnce(target);

    if (result.kind === 'ok') {
      return { buffer: result.buffer, contentType: result.contentType, finalUrl: target.url };
    }

    if (hop === MAX_REDIRECTS) {
      throw new AppError(400, 'Too many redirects');
    }

    const nextUrl = new URL(result.location, target.url);
    target = await validateUrl(nextUrl.toString());
  }

  /* istanbul ignore next — unreachable, loop always returns or throws */
  throw new AppError(400, 'Could not fetch the URL');
}

function deriveFilename(url: URL, extension: string): string {
  const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
  const base = lastSegment
    .replace(/\.[^./]+$/, '') // strip any existing extension — we use the verified one instead
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 100);
  return `${base || 'imported-image'}${extension}`;
}

export async function POST(request: Request) {
  // Stage 108: was requireUpload (role-derived canUpload) — now the
  // per-tenant 'upload' permission, resolved from the DB per request.
  const admin = await requirePermission(request, 'upload');
  if (admin instanceof Response) return admin;

  try {
    const body = await request.json();
    if (!body.url || typeof body.url !== 'string') {
      return Response.json({ message: 'url is required' }, { status: 400 });
    }

    const { collectionId } = body;
    if (collectionId != null && typeof collectionId !== 'string') {
      return Response.json({ message: 'collectionId must be a string' }, { status: 400 });
    }

    // Tenant-admin enforcement: same reasoning as upload/complete — an
    // unassigned resource is outside every tenant's reach (Stage 101), so a
    // tenant admin (canAdmin, not a true super admin) must always target a
    // collection here too. A true super admin may still import without one.
    if (collectionId == null && admin.canAdmin && !isSuperAdmin(admin)) {
      return Response.json(
        { message: 'Choose a collection for this import' },
        { status: 400 },
      );
    }

    // Fail fast on a bad collectionId before doing any network work.
    if (collectionId != null) {
      const colCheck = await db.query('SELECT id FROM collections WHERE id = $1', [collectionId]);
      if (colCheck.rowCount === 0) {
        return Response.json({ message: 'Collection not found' }, { status: 404 });
      }

      // Tenant-scoped enforcement: same cascade check upload/complete already
      // uses — a tenant admin or editor may import into only a collection
      // their tenant can reach; cross-tenant users (super admin, or can_access_all_tenants)
      // bypass this. This route's own guard is requireUpload, so editors
      // reach here too, same as upload/complete.
      if (!canAccessAllTenants(admin)) {
        if (!admin.tenantId || !(await tenantHasCollectionAccess(admin.tenantId, collectionId))) {
          return Response.json({ message: 'Access to collection denied' }, { status: 403 });
        }
      }
    }

    let buffer: Buffer;
    let contentType: string;
    let finalUrl: URL;
    try {
      ({ buffer, contentType, finalUrl } = await importImage(body.url));
    } catch (err) {
      if (err instanceof AppError) {
        return Response.json({ message: err.message }, { status: err.status });
      }
      console.error('upload/from-url: fetch failed:', err);
      return Response.json({ message: 'Could not fetch the URL' }, { status: 400 });
    }

    const extension = ALLOWED_CONTENT_TYPES[contentType];
    const filename = deriveFilename(finalUrl, extension);
    const key = `uploads/${Date.now()}-${filename}`;

    await putObject(key, buffer, contentType);

    if (collectionId != null) {
      const client = await db.connect();
      let resource!: NewResourceRow;
      try {
        await client.query('BEGIN');

        // Dedupe against files already in this collection — same helper and
        // same scoping rule as upload/complete (see lib/filenames.ts).
        const dedupedName = await resolveUniqueFilename(client, collectionId, filename);

        const result = await client.query(
          `INSERT INTO resources
             (original_filename, storage_key, mime_type, size_bytes, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, original_filename, storage_key, mime_type, size_bytes, status, created_at`,
          [dedupedName, key, contentType, buffer.length, admin.sub],
        );
        resource = result.rows[0];
        await client.query(
          'INSERT INTO collection_resource (collection_id, resource_id) VALUES ($1, $2)',
          [collectionId, resource.id],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // After client.release(), never inside the try: both calls take their
      // own connection from the shared pool, and awaiting one while still
      // holding the transaction client deadlocks a small pool outright (the
      // release that would free a connection sits in a finally the await
      // never reaches). See the fuller note in POST /api/upload/complete and
      // PG_POOL_MAX in lib/db.ts.
      logAccess({
        userId: admin.sub,
        tenantId: admin.tenantId ?? null,
        resourceId: resource.id,
        action: 'upload',
        metadata: { filename: resource.original_filename, collectionId },
      });
      await extractMetadataInline(resource.id, buffer, contentType, admin.tenantId ?? null);
      return Response.json(resource, { status: 201 });
    }

    const client = await db.connect();
    let resource!: NewResourceRow;
    try {
      await client.query('BEGIN');
      const dedupedName = await resolveUniqueFilename(client, null, filename);
      const result = await client.query(
        `INSERT INTO resources
           (original_filename, storage_key, mime_type, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, original_filename, storage_key, mime_type, size_bytes, status, created_at`,
        [dedupedName, key, contentType, buffer.length, admin.sub],
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
      userId: admin.sub,
      tenantId: admin.tenantId ?? null,
      resourceId: resource.id,
      action: 'upload',
      metadata: { filename: resource.original_filename, collectionId: null },
    });
    await extractMetadataInline(resource.id, buffer, contentType, admin.tenantId ?? null);
    return Response.json(resource, { status: 201 });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    console.error('upload/from-url failed:', err);
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
