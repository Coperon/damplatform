import { requireAuth } from '@/lib/session';
import { changePassword } from '@/lib/auth';
import { AppError } from '@/lib/errors';

export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    const result = await changePassword(auth.email, auth.sub, body.currentPassword, body.newPassword);
    return Response.json(result);
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
