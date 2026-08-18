import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, canAccessAllTenants } from '@/lib/session';
import { decrypt } from '@/lib/crypto';
import { tenantHasCollectionAccess, tenantHasResourceAccess } from '@/lib/permissions';

// Admin-only, one-share-at-a-time link retrieval — the only place besides the
// original POST /api/shares response where a full share URL is ever served.
// This does NOT touch token_hash or the public validation path (lib/shares.ts);
// it decrypts the separate token_encrypted column purely so an admin can
// re-copy a link they already have the right to see.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { id } = await ctx.params;

  const result = await db.query(
    'SELECT id, token_encrypted, collection_id, resource_id FROM shares WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Tenant-scoped enforcement: a tenant admin may re-copy the link for
  // only a share whose target their tenant can reach — cross-tenant users
  // bypass this.
  if (!canAccessAllTenants(user)) {
    if (!user.tenantId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    const reachable = row.collection_id
      ? await tenantHasCollectionAccess(user.tenantId, row.collection_id)
      : await tenantHasResourceAccess(user.tenantId, row.resource_id);
    if (!reachable) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  if (!row.token_encrypted) {
    return NextResponse.json(
      { error: "This share's link isn't retrievable — recreate the share to get a copyable link." },
      { status: 409 },
    );
  }

  let rawToken: string;
  try {
    rawToken = decrypt(row.token_encrypted);
  } catch (err) {
    // GCM auth-tag mismatch (corrupted/tampered value) or a bad/missing
    // SHARE_TOKEN_KEY both land here — fail closed, never return a guessed value.
    console.error(`Failed to decrypt token for share ${row.id}:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not decrypt this share's link." }, { status: 500 });
  }

  const baseUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const url = `${baseUrl}/share/${row.id}.${rawToken}`;

  return NextResponse.json({ url });
}
