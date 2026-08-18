import { requireAuth } from '@/lib/session';
import { getDownloadUrl } from '@/lib/storage';

export async function GET(request: Request) {
  const user = requireAuth(request);
  if (user instanceof Response) return user;

  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) {
    return Response.json({ error: 'key is required' }, { status: 400 });
  }

  const url = await getDownloadUrl(key);
  return Response.json({ url });
}
