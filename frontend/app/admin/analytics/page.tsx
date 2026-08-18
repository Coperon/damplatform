"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import Select from "@/components/Select";
import { useTranslation } from "@/lib/i18n";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

type Range = "7d" | "30d" | "90d" | "all";

const RANGE_LABEL_KEYS: Record<Range, string> = {
  "7d": "analytics.range.7d",
  "30d": "analytics.range.30d",
  "90d": "analytics.range.90d",
  all: "analytics.range.all",
};

interface TenantBreakdown {
  tenantId: string;
  tenantName: string;
  views: number;
  downloads: number;
}

interface AssetRow {
  resourceId: string | null;
  filename: string | null;
  count: number;
}

interface UserRow {
  userId: string | null;
  email: string | null;
  name: string | null;
  views: number;
  downloads: number;
  count: number;
}

interface DayRow {
  day: string;
  views: number;
  downloads: number;
}

interface AnalyticsResponse {
  range: Range;
  scope: { type: "all" | "tenant"; tenantId: string | null; tenantName: string | null };
  totals: { views: number; downloads: number };
  byTenant: TenantBreakdown[];
  topViewed: AssetRow[];
  topDownloaded: AssetRow[];
  activeUserCount: number;
  topUsers: UserRow[];
  timeSeries: DayRow[];
}

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function userLabel(row: UserRow, t: TFunc): string {
  if (row.userId === null) return t("analytics.user.deleted");
  return row.name || row.email || t("analytics.user.unknown");
}

function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="dam-glass rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</p>
      <p className="mt-1.5 text-[28px] font-semibold tabular-nums text-ink">{value.toLocaleString()}</p>
    </div>
  );
}

// Legend for the two-series charts below — a legend is always present for
// >= 2 series, per the app's data-viz convention; color follows the entity
// (Views / Downloads), never a rank that could repaint under a filter.
function SeriesLegend() {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex items-center gap-4 text-xs text-slate">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-brand" /> {t("analytics.legend.views")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-chart-downloads" /> {t("analytics.legend.downloads")}
      </span>
    </div>
  );
}

// Two-series horizontal bar list — used for the per-tenant breakdown. Bars
// share one scale (the max across every row's views/downloads) so lengths are
// comparable at a glance; counts are direct-labeled rather than relying on
// bar length alone to carry the exact value.
function TwoSeriesBarList({
  rows,
}: {
  rows: { label: string; views: number; downloads: number }[];
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.views, r.downloads]));
  return (
    <div className="space-y-4">
      {rows.map((row) => (
        <div key={row.label}>
          <p className="mb-1 truncate text-sm font-medium text-ink" title={row.label}>
            {row.label}
          </p>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-table-header">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${(row.views / max) * 100}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate">
                {row.views.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-table-header">
                <div
                  className="h-full rounded-full bg-chart-downloads"
                  style={{ width: `${(row.downloads / max) * 100}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate">
                {row.downloads.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Single-series ranked bar list — top assets / top users. One series per
// list, so no legend is needed (the panel title already names it).
function RankedBarList({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2.5">
      {rows.map((row, i) => (
        <div key={`${row.label}-${i}`} className="flex items-center gap-3">
          <span className="w-36 shrink-0 truncate text-sm text-ink" title={row.label}>
            {row.label}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-table-header">
            <div
              className="h-full rounded-full bg-brand"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-slate">
            {row.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

// Daily views/downloads — thin grouped bars, rounded data-ends, one shared
// scale. Horizontally scrollable so a 90-day range never squashes bars past
// legibility; a native `title` on each day cluster is the hover layer (no new
// dependency for a full tooltip component).
function TimeSeriesChart({ data }: { data: DayRow[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...data.flatMap((d) => [d.views, d.downloads]));
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));
  const CHART_HEIGHT = 140;

  return (
    <div className="overflow-x-auto">
      <div
        className="flex items-end gap-1 border-b border-line pb-1"
        style={{ minWidth: Math.max(320, data.length * 16) }}
      >
        {data.map((d, i) => {
          const showLabel = i === 0 || i === data.length - 1 || i % labelEvery === 0;
          return (
            <div key={d.day} className="flex flex-1 flex-col items-center">
              <div
                className="flex items-end gap-[2px]"
                style={{ height: CHART_HEIGHT }}
                title={t("analytics.chart.tooltip", { day: shortDay(d.day), views: d.views, downloads: d.downloads })}
              >
                <div
                  className="w-[5px] rounded-t-[3px] bg-brand"
                  style={{ height: d.views > 0 ? `${Math.max(2, (d.views / max) * CHART_HEIGHT)}px` : 0 }}
                />
                <div
                  className="w-[5px] rounded-t-[3px] bg-chart-downloads"
                  style={{
                    height: d.downloads > 0 ? `${Math.max(2, (d.downloads / max) * CHART_HEIGHT)}px` : 0,
                  }}
                />
              </div>
              <span className="mt-1 h-3 whitespace-nowrap text-[9px] text-slate">
                {showLabel ? shortDay(d.day) : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback((r: Range) => {
    setLoading(true);
    setLoadError(null);
    fetch(`/api/analytics?range=${encodeURIComponent(r)}`, { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || body.message || t("analytics.error.loadHttp", { status: res.status }));
        }
        return res.json() as Promise<AnalyticsResponse>;
      })
      .then((res) => setData(res))
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("analytics.error.loadGeneric")))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    const payload = parseToken(token);
    if (!payload?.canAdmin) {
      setNotAdmin(true);
      setAuthorized(true);
      return;
    }
    setIsSuperAdmin(payload?.roleName === "super_admin");
    setAuthorized(true);
    load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (!authorized || notAdmin) return;
    load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  if (!authorized) return null;

  if (notAdmin) {
    return (
      <AppShell active="analytics" title={t("nav.analytics")}>
        <div className="flex items-center justify-center py-24">
          <div className="text-center">
            <p className="text-lg font-semibold text-ink">{t("common.notAuthorized")}</p>
            <Link href="/home" className="mt-3 inline-block text-sm text-brand hover:underline">
              {t("common.backToHome")}
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  const rangeSelector = (
    <Select
      ariaLabel={t("analytics.filters.dateRangeAriaLabel")}
      value={range}
      onChange={(v) => setRange(v as Range)}
      options={(Object.keys(RANGE_LABEL_KEYS) as Range[]).map((r) => ({ value: r, label: t(RANGE_LABEL_KEYS[r]) }))}
      className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card dark:bg-card py-1.5 px-3 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
    />
  );

  const hasActivity = !!data && data.totals.views + data.totals.downloads > 0;
  const rangeLabelLower = data ? t(RANGE_LABEL_KEYS[data.range]).toLowerCase() : "";

  return (
    <AppShell active="analytics" title={t("nav.analytics")} actions={rangeSelector}>
      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && data && (
        <>
          <p className="mb-6 text-sm text-slate">
            {data.scope.type === "tenant"
              ? data.scope.tenantName
                ? t("analytics.scope.tenantWithName", { tenant: data.scope.tenantName, range: rangeLabelLower })
                : t("analytics.scope.tenantWithoutName", { range: rangeLabelLower })
              : t("analytics.scope.all", { range: rangeLabelLower })}
          </p>

          {!hasActivity ? (
            <div className="dam-glass rounded-[14px] p-10 text-center shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
              <p className="text-sm font-medium text-ink">{t("analytics.empty.title")}</p>
              <p className="mt-1 text-xs text-slate">
                {t("analytics.empty.hint")}
              </p>
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatTile label={t("analytics.stat.totalViews")} value={data.totals.views} />
                <StatTile label={t("analytics.stat.totalDownloads")} value={data.totals.downloads} />
                <StatTile label={t("analytics.stat.activeUsers")} value={data.activeUserCount} />
              </div>

              <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
                {/* Per-tenant breakdown (super admin) / single-tenant panel (tenant admin) */}
                <div className="dam-glass rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
                  <h2 className="mb-1 text-sm font-semibold text-ink">
                    {isSuperAdmin ? t("analytics.section.byCompany") : t("analytics.section.yourCompany")}
                  </h2>
                  <SeriesLegend />
                  {data.byTenant.length === 0 ? (
                    <p className="text-sm text-slate">{t("analytics.empty.byTenant")}</p>
                  ) : (
                    <TwoSeriesBarList
                      rows={data.byTenant.map((c) => ({
                        label: c.tenantName,
                        views: c.views,
                        downloads: c.downloads,
                      }))}
                    />
                  )}
                </div>

                {/* Daily time series */}
                <div className="dam-glass rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
                  <h2 className="mb-1 text-sm font-semibold text-ink">{t("analytics.section.dailyActivity")}</h2>
                  <SeriesLegend />
                  {data.timeSeries.length === 0 ? (
                    <p className="text-sm text-slate">{t("analytics.empty.timeSeries")}</p>
                  ) : (
                    <TimeSeriesChart data={data.timeSeries} />
                  )}
                </div>
              </div>

              <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="dam-glass rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
                  <h2 className="mb-3 text-sm font-semibold text-ink">{t("analytics.section.mostViewed")}</h2>
                  {data.topViewed.length === 0 ? (
                    <p className="text-sm text-slate">{t("analytics.empty.views")}</p>
                  ) : (
                    <RankedBarList
                      rows={data.topViewed.map((a) => ({
                        label: a.filename ?? t("analytics.asset.deleted"),
                        value: a.count,
                      }))}
                    />
                  )}
                </div>

                <div className="dam-glass rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
                  <h2 className="mb-3 text-sm font-semibold text-ink">{t("analytics.section.mostDownloaded")}</h2>
                  {data.topDownloaded.length === 0 ? (
                    <p className="text-sm text-slate">{t("analytics.empty.downloads")}</p>
                  ) : (
                    <RankedBarList
                      rows={data.topDownloaded.map((a) => ({
                        label: a.filename ?? t("analytics.asset.deleted"),
                        value: a.count,
                      }))}
                    />
                  )}
                </div>
              </div>

              <div className="dam-glass rounded-[14px] p-5 shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
                <h2 className="mb-3 text-sm font-semibold text-ink">{t("analytics.section.mostActiveUsers")}</h2>
                {data.topUsers.length === 0 ? (
                  <p className="text-sm text-slate">{t("analytics.empty.userActivity")}</p>
                ) : (
                  <RankedBarList
                    rows={data.topUsers.map((u) => ({
                      label: userLabel(u, t),
                      value: u.count,
                    }))}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
    </AppShell>
  );
}
