import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getEffectivePermissions } from '@/lib/permissions';

// Every authenticated role's own effective permission bundle — what the
// frontend uses to decide which buttons/kebab items to render (UI
// affordance following the same rule the server enforces). Not the matrix
// itself (that's admin-only, GET /api/permissions) — this only ever reflects
// the CALLER's own role, resolved via the same memoized DB lookup
// hasPermission uses everywhere else, so the UI and the eventual action
// check are never two different code paths that could disagree.
export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  const permissions = await getEffectivePermissions(user);
  return NextResponse.json({ permissions });
}
