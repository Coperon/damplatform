import { getDownloadUrl } from '@/lib/storage';
import { AppError } from '@/lib/errors';
import { logAccess } from '@/lib/accessLog';
import { denyUnlessResourceAccess, requirePermission } from '@/lib/permissions';
import db from '@/lib/db';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Stage 108: was requireDownload (role-derived canDownload) — now the
  // per-tenant 'download' permission. Editors keep download unconditionally
  // (it's viewer-configurable only — an editor's baseline already included
  // it); a pending user (role 5) still ends at 403 via hasPermission's
  // fall-through, same net result as the old canDownload gate.
  const user = await requirePermission(request, 'download');
  if (user instanceof Response) return user;

  try {
    const { id } = await ctx.params;

    const result = await db.query(
      'SELECT id, original_filename, storage_key, mime_type, status FROM resources WHERE id = $1',
      [id],
    );
    const resource = result.rows[0];
    if (!resource) {
      return Response.json({ message: 'Resource not found' }, { status: 404 });
    }

    const denied = await denyUnlessResourceAccess(user, id);
    if (denied) return denied;

    const downloadUrl = await getDownloadUrl(resource.storage_key);

    // Fire-and-forget access-log write — access is already authorized at this
    // point (never reached on a 403 above), so this is a real, allowed serve.
    // Not awaited: a logging failure must never affect the download itself.
    logAccess({
      userId: user.sub,
      tenantId: user.tenantId ?? null,
      resourceId: id,
      action: 'download' });

    return Response.json({
      downloadUrl,
      filename: resource.original_filename,
      mimeType: resource.mime_type });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
