import db from './db';

// 'view'/'download' are the original Stage A resource-centric events.
// 'share_create'/'share_access'/'upload'/'login' were added in a later stage
// to build a fuller "who did what" history — Stage B's analytics reader
// filters on 'view'/'download' explicitly, so these new values are simply
// ignored by those queries, never miscounted into them.
// 'all_tenants_flag_change' records a super admin setting/unsetting a user's
// can_access_all_tenants flag (PATCH /api/users/[id]) — always tenant_id: null (the
// actor is a super admin with no tenant), so tenant-scoped feeds never
// surface it; only a super admin's unscoped activity feed does.
// 'invite_flag_change' is the same shape for users.can_invite (also
// PATCH /api/users/[id], also super-admin-only, also always tenant_id: null).
// 'user_delete' records a permanent account deletion (DELETE
// /api/users/[id]) — the target's email/name/role/tenant are captured in
// metadata at write time, since the row (and therefore any join to it) is
// gone the moment this fires; tenant_id is the ACTOR's own tenant (null for
// a super admin), same convention as every other write-action log here, not
// the target's.
// 'tenant_delete' records a permanent company deletion (DELETE
// /api/tenants/[id], super-admin-only) — same shape as user_delete: the
// target's id/name plus deletion counts are captured in metadata, tenant_id
// is the actor's own (always null, since only a super admin reaches this
// route and super admins have no tenant).
export type AccessAction =
  | 'view'
  | 'download'
  | 'share_create'
  | 'share_access'
  | 'upload'
  | 'login'
  | 'all_tenants_flag_change'
  | 'invite_flag_change'
  | 'user_delete'
  | 'tenant_delete';

interface LogAccessParams {
  userId: string | null;
  tenantId: string | null;
  // Optional: null for events with no single resource (a login, or a
  // collection-target share). Resource-centric events (view/download/upload)
  // still pass a real id.
  resourceId?: string | null;
  action: AccessAction;
  // Free-form, event-specific context (e.g. a share's accessLevel, an
  // upload's filename, a login's roleName). Never a password, token, or raw
  // share token — reference credentials/secrets by id only, never by value.
  metadata?: Record<string, unknown> | null;
}

// Fire-and-forget access-event logger, feeding a future per-tenant analytics
// dashboard (logging only for now, no reader exists yet). Deliberately
// synchronous (does not return a promise for the caller to await) — the
// insert is kicked off and its own failure is caught and logged here, never
// propagated. Callers must not await this and must call it only after their
// own access check has already passed, so a denied attempt is never recorded
// as activity.
export function logAccess({
  userId,
  tenantId,
  resourceId = null,
  action,
  metadata = null,
}: LogAccessParams): void {
  db.query(
    'INSERT INTO access_log (user_id, tenant_id, resource_id, action, metadata) VALUES ($1, $2, $3, $4, $5)',
    [userId, tenantId, resourceId, action, metadata ? JSON.stringify(metadata) : null],
  ).catch((err) => {
    console.error('access_log insert failed', { action, resourceId, userId, tenantId }, err);
  });
}
