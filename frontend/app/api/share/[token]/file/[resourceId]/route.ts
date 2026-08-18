import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { validateShareToken, isResourceInShareScope, logShareAccess } from '@/lib/shares';
import { getDownloadUrl } from '@/lib/storage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string; resourceId: string }> },
) {
  const { token, resourceId } = await ctx.params;

  if (!UUID_RE.test(resourceId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Full token check, re-run on every request — this endpoint never trusts that
  // the page only asks for files it was already shown by GET /api/share/[token].
  const validation = await validateShareToken(token);
  if (validation.status !== 'valid') {
    return NextResponse.json({ status: validation.status }, { status: 404 });
  }
  const { share } = validation;

  // Independent in-scope check — the anti-scope-escape gate. A valid token for
  // collection A must never serve a resource that only lives in collection B.
  const inScope = await isResourceInShareScope(share, resourceId);
  if (!inScope) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const lookup = await db.query(
    'SELECT storage_key, thumbnail_storage_key, original_filename, mime_type FROM resources WHERE id = $1',
    [resourceId],
  );
  const resource = lookup.rows[0];
  if (!resource) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const rawMode = searchParams.get('mode');
  const mode = rawMode === 'download' ? 'download' : rawMode === 'original' ? 'original' : 'view';

  if (mode === 'download') {
    // Enforced server-side regardless of what the UI shows — a view-only share
    // can never obtain a download URL, even by hitting this endpoint directly.
    if (share.accessLevel !== 'download') {
      return NextResponse.json({ error: 'Download not permitted for this link' }, { status: 403 });
    }
    const url = await getDownloadUrl(resource.storage_key);
    // Only the real download branch logs — mode=view/original below are
    // per-thumbnail/lightbox preview fetches (the share-page equivalent of a
    // grid render) and are never logged, matching the "no card-render spam"
    // rule everywhere else in this app. Fire-and-forget, not awaited.
    logShareAccess(share, 'downloaded', resourceId);
    return NextResponse.json({ url, filename: resource.original_filename, mimeType: resource.mime_type });
  }

  // mode === 'original' — the share page's lightbox uses this to always show
  // the full-resolution image, never the small thumbnail 'view' now prefers
  // below. Deliberately has the same reach as 'view' always had for images
  // pre-thumbnail-feature: no accessLevel gate (a view-only share's gallery
  // already showed the full image inline, just with save/drag/right-click
  // disabled client-side — see the `share-no-save` styling — so this isn't a
  // new capability, only a relocation of where the existing one is reached
  // from now that 'view' no longer serves it directly for the grid).
  if (mode === 'original') {
    if (!resource.mime_type.startsWith('image/')) {
      return NextResponse.json({ error: 'Not an image' }, { status: 400 });
    }
    const url = await getDownloadUrl(resource.storage_key);
    return NextResponse.json({ url, mimeType: resource.mime_type });
  }

  // mode === 'view'
  if (resource.mime_type.startsWith('image/')) {
    // Prefer the small generated thumbnail, same as every other display
    // surface — never the full original for a preview. Falls back to the
    // original only when no thumbnail exists yet (pre-rollout files, or
    // generation still in flight), same as the video branch below.
    if (resource.thumbnail_storage_key) {
      const url = await getDownloadUrl(resource.thumbnail_storage_key);
      return NextResponse.json({ url, mimeType: 'image/jpeg' });
    }
    const url = await getDownloadUrl(resource.storage_key);
    return NextResponse.json({ url, mimeType: resource.mime_type });
  }

  if (resource.mime_type.startsWith('video/')) {
    if (resource.thumbnail_storage_key) {
      // Always the thumbnail frame for video previews, never the original video bytes.
      const url = await getDownloadUrl(resource.thumbnail_storage_key);
      return NextResponse.json({ url, mimeType: 'image/jpeg' });
    }
    if (share.accessLevel === 'download') {
      const url = await getDownloadUrl(resource.storage_key);
      return NextResponse.json({ url, mimeType: resource.mime_type });
    }
    return NextResponse.json({ url: null });
  }

  // Any other type: a view-only share gets an icon only (no URL); a download
  // share may preview the original.
  if (share.accessLevel === 'download') {
    const url = await getDownloadUrl(resource.storage_key);
    return NextResponse.json({ url, mimeType: resource.mime_type });
  }
  return NextResponse.json({ url: null });
}
