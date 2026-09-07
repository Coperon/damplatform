import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/sessionCookie';

function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true;
  if (pathname.startsWith('/invite/')) return true;
  if (pathname.startsWith('/share/')) return true;
  if (pathname === '/forgot-password' || pathname === '/reset-password') return true;
  if (pathname === '/confirm-email') return true;
  return false;
}

function isPublicApi(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname === '/api/auth/login') return true;
  if (pathname === '/api/auth/forgot-password') return true;
  if (pathname === '/api/auth/reset-password') return true;
  if (pathname.startsWith('/api/invitations/')) return true;
  if (pathname.startsWith('/api/share/')) return true;
  return false;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/api/')) {
    if (isPublicApi(pathname)) return NextResponse.next();
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  if (!request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
