# Spec 06 — Files and object storage

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Rules

- Binary in private S3-compatible storage (MinIO / B2 / Supabase Storage). Metadata in Postgres.
- Bucket is private. Clients never get a stable public object URL.
- **Server generates every key.** Complete rejects unknown keys.

## Key layout

```
tenants/{tenantId}/resources/{resourceId}/original
tenants/{tenantId}/resources/{resourceId}/renditions/{kind}
```

`resourceId` is allocated at presign time (`randomUUID()`). The pending row stores that id; complete inserts `resources.id` with the same value. The object key never contains a user-supplied filename.

Do not put original filename in the key (encoding, collisions, PII).

## Upload flow

1. `POST /api/upload/url`  
   Auth + `resource.upload` + collection in acting tenant.  
   Insert `pending_uploads` (unconsumed, expiry 1h).  
   Return `{ pendingId, uploadUrl, key }` where key is server-built.

2. Client PUT to signed URL (300s).

3. `POST /api/upload/complete` `{ pendingId }`  
   Load pending: same user, unconsumed, not expired.  
   `HeadObject` (or equivalent): exists, size ≤ maxBytes, content-type matches allowlist.  
   Transaction: insert resource `status=ready` (or `processing` if EXIF/thumb), link collection, mark pending consumed, audit `upload`.  
   Then EXIF best-effort; then optional thumbnail (or client fires thumbnail route).

`from-url` import: same domain insert after server-side fetch (keep SSRF guards). Operator/editor only. Writes object with server key then same resource insert.

## Download / view

- In-app download: permission `resource.download` (all tenant roles including viewer) + DAL get by tenant + signed GET 300s + audit `download`.
- Cover/thumbnail: authenticated tenant member or share view; signed GET on rendition key.
- Share file route: share principal; `mode=download` or original bytes only if `accessLevel=download`; view uses rendition.

## Move

Update `collection_id` in a transaction. Same tenant. Unique filename in destination → 409. Storage key **does not change** (tenant-scoped path is enough).

## Delete file

Transaction delete resource (CASCADE renditions, field data, resource shares). Then `deleteObject` original + rendition keys. If S3 fails: log, leave orphans, do not roll back committed delete (user’s intent is gone from app). GC script SHOULD exist.

## Delete collection

1. In transaction: lock tenant collections? Use recursive query **down** from target (`parent_id` walk) — this CTE is **hierarchy**, not access control.  
2. Select all resource storage keys in those collection ids.  
3. DELETE collection row (CASCADE children collections and resources).  
4. Commit.  
5. Delete S3 keys.

## Checksums

Store `checksumSha256` when we can (complete: optional client hash verified against object, or compute if object is small). Do not block v1 on hashing large files in serverless. SHOULD compute for from-url (buffer in memory, existing 15MB cap).

## Dedup / resumable

NOT worth / CAN wait. No content-addressed sharing across tenants (isolation).

## Thumbnails

In-request as today (ffmpeg, pdfjs, canvas). Persist rendition row. Do not add a queue until timeouts force it.

## Tests

Complete with forged key → 404/403. Upload into another tenant’s collection id → 404/403. Share view cannot fetch original. Subtree delete removes DB files; mock storage asserts deleteObject called for each key.
