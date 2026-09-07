import { forgotPassword } from '@/lib/auth';
import { AppError } from '@/lib/errors';
import { rateLimitOr429 } from '@/lib/rateLimit';

export async function POST(request: Request) {
  const limited = await rateLimitOr429(request, 'forgot-password', 5, 15 * 60);
  if (limited) return limited;

  try {
    const body = await request.json();
    const result = await forgotPassword(body.email);
    return Response.json(result);
  } catch (err) {
    if (err instanceof AppError) {
      return Response.json({ message: err.message }, { status: err.status });
    }
    return Response.json({ message: 'Internal server error' }, { status: 500 });
  }
}
