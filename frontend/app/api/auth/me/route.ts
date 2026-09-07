import { requireAuth } from '@/lib/session';

export async function GET(request: Request) {
  const user = requireAuth(request);
  if (user instanceof Response) return user;

  return Response.json({
    sub: user.sub,
    email: user.email,
    name: user.name ?? null,
    canDownload: user.canDownload,
    canUpload: user.canUpload,
    canAdmin: user.canAdmin,
    tenantId: user.tenantId ?? null,
    roleId: user.roleId ?? null,
    roleName: user.roleName ?? null,
    canAccessAllTenants: user.canAccessAllTenants === true,
    canInvite: user.canInvite === true });
}
