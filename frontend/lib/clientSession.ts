export type SessionClaims = {
  sub: string;
  email: string;
  name: string | null;
  canDownload: boolean;
  canUpload: boolean;
  canAdmin: boolean;
  tenantId: string | null;
  roleId: number | null;
  roleName: string | null;
  canAccessAllTenants: boolean;
  canInvite: boolean;
};

let cache: SessionClaims | null | undefined;

export function clearSessionCache() {
  cache = undefined;
}

export async function getSessionClaims(): Promise<SessionClaims | null> {
  if (cache !== undefined) return cache;
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) {
      cache = null;
      return null;
    }
    cache = (await res.json()) as SessionClaims;
    return cache;
  } catch {
    cache = null;
    return null;
  }
}
