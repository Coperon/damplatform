import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAuth } from '@/lib/session';

const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 255;
const MAX_PHONE_LENGTH = 30;

// A company admin's own company details — scoped from the TOKEN's own
// tenantId, never a request param, and never lib/session.ts's
// actingTenantId(). The acting-company switcher (AppShell's "Acting as"
// pill) lets a cross-tenant admin BROWSE another company's collections/media/
// users; editing "my company" on the Profile page always means the
// caller's own home company, switcher selection or not — otherwise
// switching companies for a five-second look at someone else's media
// library would silently put a cross-tenant admin one Save away from renaming
// a company they don't belong to. This is enforced simply by never calling
// actingTenantId here at all — user.tenantId is the only source, always.
//
// True super admins (role 1) have no tenant and never reach this route (the
// Profile page hides the section for them entirely, see the GET handler in
// ../route.ts). Editors/viewers (3/4) aren't gated on canAdmin here — only a
// true company admin (role_id === 2, cross-tenant access or not) may ever call this.
export async function PATCH(req: NextRequest) {
  const user = requireAuth(req);
  if (user instanceof Response) return user;

  if (user.roleId !== 2) {
    return NextResponse.json(
      { error: 'Only a company admin can edit company details' },
      { status: 403 },
    );
  }
  if (!user.tenantId) {
    return NextResponse.json({ error: 'Your account has no company to edit' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if ('name' in body) {
    const name = (body as { name: unknown }).name;
    if (typeof name !== 'string') {
      return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return NextResponse.json({ error: 'Company name is required' }, { status: 400 });
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Company name must be ${MAX_NAME_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }
    // Same case-insensitive duplicate check as POST /api/tenants (tenants
    // has no DB-level unique constraint on name), excluding this tenant's
    // own current row so re-saving the same name isn't a false 409.
    const dup = await db.query(
      'SELECT id FROM tenants WHERE LOWER(name) = LOWER($1) AND id <> $2',
      [trimmed, user.tenantId],
    );
    if ((dup.rowCount ?? 0) > 0) {
      return NextResponse.json({ error: 'A company with this name already exists' }, { status: 409 });
    }
    params.push(trimmed);
    setClauses.push(`name = $${params.length}`);
  }

  if ('address' in body) {
    const address = (body as { address: unknown }).address;
    if (typeof address !== 'string') {
      return NextResponse.json({ error: 'address must be a string' }, { status: 400 });
    }
    const trimmed = address.trim();
    if (!trimmed) {
      return NextResponse.json({ error: 'Company address is required' }, { status: 400 });
    }
    if (trimmed.length > MAX_ADDRESS_LENGTH) {
      return NextResponse.json(
        { error: `Company address must be ${MAX_ADDRESS_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }
    params.push(trimmed);
    setClauses.push(`address = $${params.length}`);
  }

  if ('phone' in body) {
    const phone = (body as { phone: unknown }).phone;
    if (typeof phone !== 'string') {
      return NextResponse.json({ error: 'phone must be a string' }, { status: 400 });
    }
    const trimmed = phone.trim();
    if (!trimmed) {
      return NextResponse.json({ error: 'Company phone is required' }, { status: 400 });
    }
    if (trimmed.length > MAX_PHONE_LENGTH) {
      return NextResponse.json(
        { error: `Company phone must be ${MAX_PHONE_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }
    params.push(trimmed);
    setClauses.push(`phone = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
  }

  params.push(user.tenantId);
  const result = await db.query<{
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
  }>(
    `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, address, phone`,
    params,
  );

  return NextResponse.json(result.rows[0]);
}
