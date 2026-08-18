import { resetPassword } from '@/lib/auth';
import { AppError } from '@/lib/errors';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await resetPassword(body.token, body.newPassword);
    return Response.json(result);
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
