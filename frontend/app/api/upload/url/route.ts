import { getUploadUrl } from '@/lib/storage';
import { AppError } from '@/lib/errors';
import { requirePermission } from '@/lib/permissions';

export async function POST(request: Request) {
  // Stage 108: was requireUpload (role-derived canUpload) — now the
  // per-tenant 'upload' permission, resolved from the DB per request.
  const user = await requirePermission(request, 'upload');
  if (user instanceof Response) return user;

  try {
    const body = await request.json();
    if (!body.filename || !body.contentType) {
      return Response.json({ message: 'filename and contentType are required' }, { status: 400 });
    }

    const key = `uploads/${Date.now()}-${body.filename}`;
    const uploadUrl = await getUploadUrl(key, body.contentType);
    return Response.json({ uploadUrl, key });
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
