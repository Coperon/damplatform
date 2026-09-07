import { isUuid, requireAuth } from '@/lib/session';
import { denyUnlessCollectionAccess, denyUnlessResourceAccess } from '@/lib/permissions';
import { getDownloadUrl } from '@/lib/storage';
import db from '@/lib/db';

export async function GET(request: Request) {
  const user = requireAuth(request);
  if (user instanceof Response) return user;

  const { searchParams } = new URL(request.url);
  if (searchParams.get('key')) {
    return Response.json(
      { error: 'Pass resourceId or collectionId; storage keys are not accepted' },
      { status: 400 },
    );
  }

  const resourceId = searchParams.get('resourceId');
  const collectionId = searchParams.get('collectionId');
  if ((resourceId && collectionId) || (!resourceId && !collectionId)) {
    return Response.json(
      { error: 'Provide exactly one of resourceId or collectionId' },
      { status: 400 },
    );
  }

  try {
    if (resourceId) {
      if (!isUuid(resourceId)) {
        return Response.json({ error: 'Invalid resourceId' }, { status: 400 });
      }
      const denied = await denyUnlessResourceAccess(user, resourceId);
      if (denied) return denied;

      const result = await db.query(
        'SELECT thumbnail_storage_key FROM resources WHERE id = $1',
        [resourceId],
      );
      const key: string | null = result.rows[0]?.thumbnail_storage_key ?? null;
      if (!key) {
        return Response.json({ error: 'Cover not found' }, { status: 404 });
      }
      const url = await getDownloadUrl(key);
      return Response.json({ url });
    }

    if (!collectionId || !isUuid(collectionId)) {
      return Response.json({ error: 'Invalid collectionId' }, { status: 400 });
    }
    const denied = await denyUnlessCollectionAccess(user, collectionId);
    if (denied) return denied;

    const result = await db.query(
      'SELECT cover_storage_key FROM collections WHERE id = $1',
      [collectionId],
    );
    const key: string | null = result.rows[0]?.cover_storage_key ?? null;
    if (!key) {
      return Response.json({ error: 'Cover not found' }, { status: 404 });
    }
    const url = await getDownloadUrl(key);
    return Response.json({ url });
  } catch {
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
