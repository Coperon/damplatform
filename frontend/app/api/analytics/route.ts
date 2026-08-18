import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireAdmin, isSuperAdmin, actingTenantId } from '@/lib/session';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelisted ranges mapped to a day count; 'all' has no lower bound at all.
// Unrecognised values fall back to the default, same convention as
// GET /api/media's pageSize/sort whitelists — never a 400 for a bad range.
const RANGE_DAYS: Record<string, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};
const DEFAULT_RANGE = '30d';
const TOP_LIMIT = 10;

interface Conditions {
  clauses: string[];
  params: unknown[];
}

// Shared WHERE-building block for every query below: tenant scope (from the
// token, never the request — see the tenantId override logic in GET) and the
// range's lower bound. Each caller clones `clauses`/`params` before appending
// its own extra condition (e.g. `action = 'view'`), so no query accidentally
// shares mutated state with another.
function baseConditions(tenantScope: string | null, since: Date | null): Conditions {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (tenantScope !== null) {
    params.push(tenantScope);
    clauses.push(`al.tenant_id = $${params.length}`);
  }
  if (since !== null) {
    params.push(since);
    clauses.push(`al.created_at >= $${params.length}`);
  }
  return { clauses, params };
}

function whereSql(cond: Conditions): string {
  return cond.clauses.length > 0 ? `WHERE ${cond.clauses.join(' AND ')}` : '';
}

// N calendar days ending today, inclusive (rangeDays=7 → today + 6 previous
// days = 7 buckets) — the same anchor date feeds both the row filters above
// and the daily time-series below, so the headline totals and the sum of the
// series always agree.
function startOfRange(rangeDays: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (rangeDays - 1));
  return d;
}

export async function GET(req: NextRequest) {
  const user = requireAdmin(req);
  if (user instanceof Response) return user;

  const { searchParams } = new URL(req.url);
  const superAdmin = isSuperAdmin(user);

  const rangeParam = searchParams.get('range') ?? DEFAULT_RANGE;
  const range = rangeParam in RANGE_DAYS ? rangeParam : DEFAULT_RANGE;
  const rangeDays = RANGE_DAYS[range];
  const since = rangeDays !== null ? startOfRange(rangeDays) : null;

  // Scope is always taken from the token, never the request. A super admin
  // may optionally narrow to one tenant via ?tenantId= (a drill-down, not a
  // widening); a tenant admin's own tenantId always wins regardless of what
  // (if anything) is in the query string — same silent-override discipline as
  // POST /api/invitations.
  let tenantScope: string | null = null;
  if (superAdmin) {
    const requested = searchParams.get('tenantId');
    if (requested !== null) {
      if (!UUID_RE.test(requested)) {
        return NextResponse.json({ error: 'tenantId must be a uuid' }, { status: 400 });
      }
      tenantScope = requested;
    }
  } else {
    // cross-tenant admins are scoped to the tenant they're acting as (the
    // switcher cookie, defaulting to their own tenant); regular tenant
    // admins to their own token tenantId (cookie silently ignored).
    // Fail closed: no resolvable tenant gets an empty result rather than
    // falling back to "see everyone."
    const effectiveTenant = actingTenantId(user, req);
    if (!effectiveTenant) {
      return NextResponse.json({
        range,
        scope: { type: 'tenant', tenantId: null, tenantName: null },
        totals: { views: 0, downloads: 0 },
        byTenant: [],
        topViewed: [],
        topDownloaded: [],
        activeUserCount: 0,
        topUsers: [],
        timeSeries: [],
      });
    }
    tenantScope = effectiveTenant;
  }

  const cond = baseConditions(tenantScope, since);

  const scopeTenantNamePromise =
    tenantScope !== null
      ? db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantScope])
      : Promise.resolve(null);

  const totalsPromise = db.query<{ views: string; downloads: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE al.action = 'view') AS views,
       COUNT(*) FILTER (WHERE al.action = 'download') AS downloads
     FROM access_log al
     ${whereSql(cond)}`,
    cond.params,
  );

  // Per-tenant breakdown — the INNER JOIN naturally excludes tenant_id IS
  // NULL rows (e.g. a super admin's own activity), which have no tenant to
  // attribute to. For a tenant admin this returns at most their own single
  // row, since `cond` already restricts to their tenant_id.
  const byTenantPromise = db.query<{
    tenant_id: string;
    tenant_name: string;
    views: string;
    downloads: string;
  }>(
    `SELECT co.id AS tenant_id, co.name AS tenant_name,
            COUNT(*) FILTER (WHERE al.action = 'view') AS views,
            COUNT(*) FILTER (WHERE al.action = 'download') AS downloads
     FROM access_log al
     INNER JOIN tenants co ON co.id = al.tenant_id
     ${whereSql(cond)}
     GROUP BY co.id, co.name
     ORDER BY (COUNT(*)) DESC, co.name`,
    cond.params,
  );

  function topAssetsQuery(action: 'view' | 'download') {
    const c: Conditions = { clauses: [...cond.clauses], params: [...cond.params] };
    c.params.push(action);
    c.clauses.push(`al.action = $${c.params.length}`);
    c.params.push(TOP_LIMIT);
    const limitIdx = c.params.length;
    return db.query<{ resource_id: string | null; original_filename: string | null; count: string }>(
      `SELECT al.resource_id, r.original_filename, COUNT(*) AS count
       FROM access_log al
       LEFT JOIN resources r ON r.id = al.resource_id
       ${whereSql(c)}
       GROUP BY al.resource_id, r.original_filename
       ORDER BY COUNT(*) DESC
       LIMIT $${limitIdx}`,
      c.params,
    );
  }

  const activeUsersPromise = db.query<{ active_user_count: string }>(
    `SELECT COUNT(DISTINCT al.user_id) AS active_user_count
     FROM access_log al
     ${whereSql(cond)}`,
    cond.params,
  );

  const topUsersPromise = (() => {
    const c: Conditions = { clauses: [...cond.clauses], params: [...cond.params] };
    c.params.push(TOP_LIMIT);
    const limitIdx = c.params.length;
    return db.query<{
      user_id: string | null;
      email: string | null;
      name: string | null;
      views: string;
      downloads: string;
      count: string;
    }>(
      `SELECT al.user_id, u.email, u.name,
              COUNT(*) FILTER (WHERE al.action = 'view') AS views,
              COUNT(*) FILTER (WHERE al.action = 'download') AS downloads,
              COUNT(*) AS count
       FROM access_log al
       LEFT JOIN users u ON u.id = al.user_id
       ${whereSql(cond)}
       GROUP BY al.user_id, u.email, u.name
       ORDER BY COUNT(*) DESC
       LIMIT $${limitIdx}`,
      c.params,
    );
  })();

  // Time series needs its own start-of-range anchor even for 'all' (which has
  // no fixed lower bound elsewhere) — resolved from the earliest event in
  // scope, so a sparse/near-empty log still produces a well-formed (possibly
  // empty) series rather than an unbounded generate_series.
  let seriesStart: Date | null = since;
  if (seriesStart === null) {
    const minRes = await db.query<{ min_created: string | null }>(
      `SELECT MIN(al.created_at) AS min_created FROM access_log al ${whereSql(cond)}`,
      cond.params,
    );
    const minCreated = minRes.rows[0]?.min_created;
    seriesStart = minCreated ? new Date(minCreated) : null;
  }

  let timeSeriesPromise: Promise<{ rows: { day: string; views: string; downloads: string }[] }>;
  if (seriesStart === null) {
    timeSeriesPromise = Promise.resolve({ rows: [] });
  } else {
    const seriesCond: Conditions = { clauses: [...cond.clauses], params: [...cond.params] };
    // The generate_series bound is appended after the shared where-params so
    // its own placeholder index is stable regardless of how many tenant/
    // since conditions preceded it.
    seriesCond.params.push(seriesStart.toISOString().slice(0, 10));
    const startIdx = seriesCond.params.length;
    timeSeriesPromise = db.query<{ day: string; views: string; downloads: string }>(
      `WITH filtered AS (
         SELECT date_trunc('day', al.created_at)::date AS day, al.action
         FROM access_log al
         ${whereSql(seriesCond)}
       ),
       days AS (
         SELECT generate_series($${startIdx}::date, CURRENT_DATE, interval '1 day')::date AS day
       )
       SELECT days.day,
              COUNT(*) FILTER (WHERE filtered.action = 'view') AS views,
              COUNT(*) FILTER (WHERE filtered.action = 'download') AS downloads
       FROM days
       LEFT JOIN filtered ON filtered.day = days.day
       GROUP BY days.day
       ORDER BY days.day`,
      seriesCond.params,
    );
  }

  const [
    scopeTenantNameResult,
    totalsResult,
    byTenantResult,
    topViewedResult,
    topDownloadedResult,
    activeUsersResult,
    topUsersResult,
    timeSeriesResult,
  ] = await Promise.all([
    scopeTenantNamePromise,
    totalsPromise,
    byTenantPromise,
    topAssetsQuery('view'),
    topAssetsQuery('download'),
    activeUsersPromise,
    topUsersPromise,
    timeSeriesPromise,
  ]);

  const totalsRow = totalsResult.rows[0];

  return NextResponse.json({
    range,
    scope: {
      type: tenantScope !== null ? 'tenant' : 'all',
      tenantId: tenantScope,
      tenantName: scopeTenantNameResult?.rows[0]?.name ?? null,
    },
    totals: {
      views: Number(totalsRow?.views ?? 0),
      downloads: Number(totalsRow?.downloads ?? 0),
    },
    byTenant: byTenantResult.rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      views: Number(r.views),
      downloads: Number(r.downloads),
    })),
    topViewed: topViewedResult.rows.map((r) => ({
      resourceId: r.resource_id,
      filename: r.resource_id === null ? '(deleted asset)' : r.original_filename,
      count: Number(r.count),
    })),
    topDownloaded: topDownloadedResult.rows.map((r) => ({
      resourceId: r.resource_id,
      filename: r.resource_id === null ? '(deleted asset)' : r.original_filename,
      count: Number(r.count),
    })),
    activeUserCount: Number(activeUsersResult.rows[0]?.active_user_count ?? 0),
    topUsers: topUsersResult.rows.map((r) => ({
      userId: r.user_id,
      email: r.user_id === null ? null : r.email,
      name: r.user_id === null ? '(deleted user)' : r.name,
      views: Number(r.views),
      downloads: Number(r.downloads),
      count: Number(r.count),
    })),
    timeSeries: timeSeriesResult.rows.map((r) => ({
      day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
      views: Number(r.views),
      downloads: Number(r.downloads),
    })),
  });
}
