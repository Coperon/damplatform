"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import Select from "@/components/Select";
import { useTranslation } from "@/lib/i18n";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

// Splits a raw (unsubstituted) translation template on its {{token}}
// placeholders and re-assembles it as JSX, substituting each token with a
// ReactNode (e.g. a <Bold> actor name) rather than a plain string. This is
// what lets the activity feed keep bold actor/resource/target names inside
// a fully-translated sentence: the split happens on the *localized* template
// wherever the translator placed each token, so word order is still correct
// per language — unlike concatenating separately-translated fragments.
function interpolateJSX(template: string, params: Record<string, React.ReactNode>): React.ReactNode[] {
  return template.split(/(\{\{\w+\}\})/g).map((part, i) => {
    const match = part.match(/^\{\{(\w+)\}\}$/);
    if (match && match[1] in params) {
      return <Fragment key={i}>{params[match[1]]}</Fragment>;
    }
    return part;
  });
}

type Range = "7d" | "30d" | "90d" | "all";
type AccessAction =
  | "view"
  | "download"
  | "share_create"
  | "share_access"
  | "upload"
  | "login"
  | "all_tenants_flag_change"
  | "invite_flag_change"
  | "user_delete"
  | "tenant_delete";

const RANGE_LABEL_KEYS: Record<Range, string> = {
  "7d": "analytics.range.7d",
  "30d": "analytics.range.30d",
  "90d": "analytics.range.90d",
  all: "analytics.range.all",
};

const ACTION_LABEL_KEYS: Record<AccessAction, string> = {
  login: "activity.action.login",
  upload: "activity.action.upload",
  view: "analytics.legend.views",
  download: "analytics.legend.downloads",
  share_create: "activity.action.shareCreate",
  share_access: "activity.action.shareAccess",
  all_tenants_flag_change: "activity.action.allTenantsFlagChange",
  invite_flag_change: "activity.action.inviteFlagChange",
  user_delete: "activity.action.userDelete",
  tenant_delete: "activity.action.tenantDelete",
};
const ALL_ACTIONS: AccessAction[] = [
  "login",
  "upload",
  "view",
  "download",
  "share_create",
  "share_access",
  "all_tenants_flag_change",
  "invite_flag_change",
  "user_delete",
  "tenant_delete",
];

interface ActorInfo {
  userId: string | null;
  name: string | null;
  email: string | null;
}
interface ResourceInfo {
  id: string;
  filename: string | null;
}
interface TargetInfo {
  type: "collection" | "resource";
  id: string | null;
  name: string | null;
}
interface ActivityEvent {
  id: string;
  action: AccessAction;
  createdAt: string;
  tenantId: string | null;
  tenantName: string | null;
  actor: ActorInfo;
  resource: ResourceInfo | null;
  target: TargetInfo | null;
  detail: Record<string, unknown>;
}
interface ScopeInfo {
  type: "all" | "tenant";
  tenantId: string | null;
  tenantName: string | null;
}
interface ActivityResponse {
  scope: ScopeInfo;
  range: Range;
  events: ActivityEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}
interface UserOption {
  id: string;
  label: string;
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

function ChevronIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-slate" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M5.5 8l4.5 4.5L14.5 8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LoginIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 4.5H5a1 1 0 00-1 1v9a1 1 0 001 1h3M13 14l4-4-4-4M17 10H7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 13V4M6.5 7.5L10 4l3.5 3.5M4 14.5v1.5a1 1 0 001 1h10a1 1 0 001-1v-1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ViewIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 10s2.7-5 8-5 8 5 8 5-2.7 5-8 5-8-5-8-5z" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.2" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3v10M6.5 9.5L10 13l3.5-3.5M4 15.5v1a1 1 0 001 1h10a1 1 0 001-1v-1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ShareCreateIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="15" cy="5" r="2" />
      <circle cx="5" cy="10" r="2" />
      <circle cx="15" cy="15" r="2" />
      <path d="M6.8 9.1l6.4-3.2M6.8 10.9l6.4 3.2" strokeLinecap="round" />
    </svg>
  );
}
function ShareAccessIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 12a4 4 0 100-8 4 4 0 000 8z" />
      <path d="M4.5 17c0-2.2 1.9-3.5 3.5-3.5s3.5 1.3 3.5 3.5" strokeLinecap="round" />
      <path d="M13 4l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ActionIcon({ action }: { action: AccessAction }) {
  switch (action) {
    case "login":
      return <LoginIcon />;
    case "upload":
      return <UploadIcon />;
    case "view":
      return <ViewIcon />;
    case "download":
      return <DownloadIcon />;
    case "share_create":
      return <ShareCreateIcon />;
    case "share_access":
      return <ShareAccessIcon />;
    case "all_tenants_flag_change":
      return <AllTenantsFlagIcon />;
    case "invite_flag_change":
      return <InviteFlagIcon />;
    case "user_delete":
      return <UserDeleteIcon />;
    case "tenant_delete":
      return <TenantDeleteIcon />;
  }
}

function UserDeleteIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="6.5" r="3" />
      <path d="M2.5 17c0-3 2.5-5 5.5-5s5.5 2 5.5 5" strokeLinecap="round" />
      <path d="M14 8l3.5 3.5M17.5 8L14 11.5" strokeLinecap="round" />
    </svg>
  );
}

function TenantDeleteIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 17V5.5a1 1 0 011-1h6a1 1 0 011 1V17" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17h10M7 8h1M10.5 8h1M7 11h1M10.5 11h1" strokeLinecap="round" />
      <path d="M13.5 17v-4.5H16a1 1 0 011 1V17" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.5 4l3 3-3 3M17.2 7H12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AllTenantsFlagIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 2.5l6 2.5v4c0 4-2.5 6.7-6 8.5-3.5-1.8-6-4.5-6-8.5V5l6-2.5z" strokeLinejoin="round" />
      <path d="M7.5 10l1.8 1.8 3.2-3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InviteFlagIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3.5 5.5a1.5 1.5 0 011.5-1.5h10a1.5 1.5 0 011.5 1.5v9a1.5 1.5 0 01-1.5 1.5H5a1.5 1.5 0 01-1.5-1.5v-9z" strokeLinejoin="round" />
      <path d="M4 5.5l6 5 6-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Tiny local helper, not a library — "just now" / "Nm ago" / "Nh ago" / "Nd
// ago" / "Nmo ago" / "Ny ago". Exact timestamp is always available on hover
// via the row's own `title`.
function relativeTime(iso: string, t: TFunc): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return t("activity.time.justNow");
  if (sec < 60) return t("activity.time.secondsAgo", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("activity.time.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("activity.time.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t("activity.time.daysAgo", { n: day });
  const mo = Math.floor(day / 30);
  if (mo < 12) return t("activity.time.monthsAgo", { n: mo });
  const yr = Math.floor(day / 365);
  return t("activity.time.yearsAgo", { n: yr });
}

// Older-than-yesterday day headings fall back to the browser's own locale
// (toLocaleDateString(undefined, ...)) rather than the app's manually-chosen
// language — a pre-existing convention shared by every date formatter in
// this app (users/tenants/shares/analytics pages), not something this pass
// changes. Only "Today"/"Yesterday" are app strings, so only those are keyed.
function dayLabel(iso: string, t: TFunc): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return t("activity.day.today");
  if (diffDays === 1) return t("activity.day.yesterday");
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function groupByDay(events: ActivityEvent[], t: TFunc): { label: string; events: ActivityEvent[] }[] {
  const groups: { label: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const label = dayLabel(e.createdAt, t);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(e);
    else groups.push({ label, events: [e] });
  }
  return groups;
}

// "(deleted user)" only for an event that genuinely had a user who's since
// been removed (FK ON DELETE SET NULL). share_access is anonymous by
// design — never rendered as a deleted user, always "Someone".
function actorLabel(e: ActivityEvent, t: TFunc): string {
  if (e.action === "share_access") return t("activity.actor.someone");
  if (e.actor.userId === null) return t("analytics.user.deleted");
  return e.actor.name || e.actor.email || t("analytics.user.unknown");
}
function resourceLabel(e: ActivityEvent, t: TFunc): string {
  if (!e.resource) return "";
  return e.resource.filename ?? t("analytics.asset.deleted");
}
function targetLabel(e: ActivityEvent, t: TFunc): string {
  if (!e.target) return "";
  return e.target.name ?? t("activity.target.deleted");
}

function Bold({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

// Structured fields (actor/action/target/detail) come straight from the API;
// phrasing per action lives here, client-side, per the task's own preference
// for structure-over-prerendered-strings. Each action is one translation key
// (interpolateJSX substitutes {{actor}}/{{resource}}/{{target}} with bold
// JSX at whatever position the localized template puts them — never built
// by concatenating separately-translated fragments) plus, where the source
// had a trailing " · …" clause (role name, expiry, delete counts), that
// clause is appended as its own short, independently-translated phrase.
function ActivityLine({ e }: { e: ActivityEvent }) {
  const { t } = useTranslation();
  const actor = <Bold>{actorLabel(e, t)}</Bold>;

  switch (e.action) {
    case "login": {
      const roleName = typeof e.detail.roleName === "string" ? e.detail.roleName : null;
      return (
        <>
          {interpolateJSX(t("activity.line.login"), { actor })}
          {roleName ? <span className="text-slate"> · {roleName}</span> : null}
        </>
      );
    }
    case "upload": {
      const collectionId = e.detail.collectionId as string | null;
      const collectionName = collectionId
        ? (<Bold>{(e.detail.collectionName as string | null) ?? t("activity.line.deletedCollection")}</Bold>)
        : null;
      const resource = <Bold>{resourceLabel(e, t)}</Bold>;
      return collectionName ? (
        <>{interpolateJSX(t("activity.line.uploadInto"), { actor, resource, collection: collectionName })}</>
      ) : (
        <>{interpolateJSX(t("activity.line.upload"), { actor, resource })}</>
      );
    }
    case "view":
      return <>{interpolateJSX(t("activity.line.view"), { actor, resource: <Bold>{resourceLabel(e, t)}</Bold> })}</>;
    case "download":
      return <>{interpolateJSX(t("activity.line.download"), { actor, resource: <Bold>{resourceLabel(e, t)}</Bold> })}</>;
    case "share_create": {
      const accessLevel =
        e.detail.accessLevel === "download" ? t("activity.line.accessLevelDownload") : t("activity.line.accessLevelViewOnly");
      const expiresAt = e.detail.expiresAt as string | null;
      const target = <Bold>{targetLabel(e, t)}</Bold>;
      return (
        <>
          {interpolateJSX(t("activity.line.shareCreate"), { actor, target, accessLevel })}
          <span className="text-slate">
            {" "}
            · {expiresAt ? t("activity.line.expiresOn", { date: new Date(expiresAt).toLocaleDateString() }) : t("activity.line.neverExpires")}
          </span>
        </>
      );
    }
    case "share_access": {
      const verb = e.detail.shareAction === "downloaded" ? t("activity.line.verbDownloaded") : t("activity.line.verbViewed");
      const label = e.resource ? resourceLabel(e, t) : targetLabel(e, t);
      return <>{interpolateJSX(t("activity.line.shareAccess"), { actor, verb, target: <Bold>{label}</Bold> })}</>;
    }
    case "all_tenants_flag_change": {
      const targetEmail = typeof e.detail.targetEmail === "string" ? e.detail.targetEmail : t("analytics.user.unknown");
      const granted = e.detail.newValue === true;
      const key = granted ? "activity.line.allTenantsGranted" : "activity.line.allTenantsRemoved";
      return <>{interpolateJSX(t(key), { actor, target: <Bold>{targetEmail}</Bold> })}</>;
    }
    case "invite_flag_change": {
      const targetEmail = typeof e.detail.targetEmail === "string" ? e.detail.targetEmail : t("analytics.user.unknown");
      const granted = e.detail.newValue === true;
      const key = granted ? "activity.line.inviteGranted" : "activity.line.inviteRemoved";
      return <>{interpolateJSX(t(key), { actor, target: <Bold>{targetEmail}</Bold> })}</>;
    }
    case "user_delete": {
      const deletedUserLabel =
        (typeof e.detail.targetName === "string" && e.detail.targetName) ||
        (typeof e.detail.targetEmail === "string" ? e.detail.targetEmail : t("analytics.user.unknown"));
      return <>{interpolateJSX(t("activity.line.userDelete"), { actor, target: <Bold>{deletedUserLabel}</Bold> })}</>;
    }
    case "tenant_delete": {
      const targetName =
        typeof e.detail.targetTenantName === "string" ? e.detail.targetTenantName : t("activity.line.unknownCompany");
      const users = typeof e.detail.usersDeleted === "number" ? e.detail.usersDeleted : 0;
      const collections = typeof e.detail.collectionsDeleted === "number" ? e.detail.collectionsDeleted : 0;
      const resources = typeof e.detail.resourcesDeleted === "number" ? e.detail.resourcesDeleted : 0;
      return (
        <>
          {interpolateJSX(t("activity.line.tenantDelete"), { actor, target: <Bold>{targetName}</Bold> })}
          <span className="text-slate">
            {" "}
            · {t("users.count", { count: users })}
            {t("common.listSeparator")}
            {t("activity.line.collectionsCount", { count: collections })}
            {t("common.listSeparator")}
            {t("media.fileCount", { count: resources })}
          </span>
        </>
      );
    }
  }
}

function EventRow({ event, showTenant }: { event: ActivityEvent; showTenant: boolean }) {
  const { t } = useTranslation();
  const isShareAccess = event.action === "share_access";
  const isDelete = event.action === "user_delete" || event.action === "tenant_delete";
  return (
    <div className={`flex items-start gap-3 px-4 py-3 ${isShareAccess ? "bg-surface-tint/40" : ""}`}>
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isShareAccess
            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            : isDelete
              ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400"
              : "bg-surface-tint text-brand"
        }`}
      >
        <ActionIcon action={event.action} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm ${isShareAccess ? "italic text-slate" : "text-ink"}`}>
          <ActivityLine e={event} />
          {isShareAccess && (
            <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 not-italic dark:bg-amber-900/40 dark:text-amber-300">
              {t("activity.badge.external")}
            </span>
          )}
        </p>
        {showTenant && event.tenantName && (
          <span className="mt-1 inline-block rounded-full bg-surface-tint px-2 py-0.5 text-[11px] text-slate">
            {event.tenantName}
          </span>
        )}
      </div>
      <span className="shrink-0 whitespace-nowrap text-xs text-slate" title={new Date(event.createdAt).toLocaleString()}>
        {relativeTime(event.createdAt, t)}
      </span>
    </div>
  );
}

// Portal-rendered checkbox popover — this page's top bar lives inside
// AppShell's `.dam-glass-topbar` (backdrop-filter), which traps a naively
// absolutely-positioned dropdown below the page's own outside-click overlay
// (see CollectionTreePicker.tsx and "Conventions that bite" in STATE.md).
// Same fixed-from-trigger-rect pattern, simplified to a flat checkbox list.
function ActionFilter({
  selected,
  onChange,
}: {
  selected: AccessAction[];
  onChange: (next: AccessAction[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function openPanel() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(rect.width, 220);
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      setPos({ top: rect.bottom + 6, left, width });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  function toggle(action: AccessAction) {
    onChange(selected.includes(action) ? selected.filter((a) => a !== action) : [...selected, action]);
  }

  const label =
    selected.length === 0
      ? t("activity.filter.allActions")
      : selected.length === 1
        ? t(ACTION_LABEL_KEYS[selected[0]])
        : t("activity.filter.nActionsSelected", { count: selected.length });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-line bg-card px-3 py-1.5 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15 dark:bg-card"
      >
        {label}
        <ChevronIcon />
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 rounded-[10px] border border-line bg-card p-1.5 shadow-lg dark:bg-card"
              style={{ top: pos.top, left: pos.left, width: pos.width }}
            >
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="mb-1 w-full cursor-pointer rounded-[6px] px-2 py-1 text-left text-xs text-brand hover:bg-mist"
                >
                  {t("activity.filter.clear")}
                </button>
              )}
              {ALL_ACTIONS.map((a) => (
                <label key={a} className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-sm text-ink hover:bg-mist">
                  <input
                    type="checkbox"
                    checked={selected.includes(a)}
                    onChange={() => toggle(a)}
                    className="h-3.5 w-3.5 accent-brand"
                  />
                  {t(ACTION_LABEL_KEYS[a])}
                </label>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export default function ActivityPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  const [range, setRange] = useState<Range>("30d");
  const [actionFilter, setActionFilter] = useState<AccessAction[]>([]);
  const [userIdFilter, setUserIdFilter] = useState<string>("");
  const [users, setUsers] = useState<UserOption[]>([]);

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [scope, setScope] = useState<ScopeInfo | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const buildUrl = useCallback(
    (cursorVal: string | null) => {
      const params = new URLSearchParams();
      params.set("range", range);
      actionFilter.forEach((a) => params.append("action", a));
      if (userIdFilter) params.set("userId", userIdFilter);
      if (cursorVal) params.set("cursor", cursorVal);
      return `/api/activity?${params.toString()}`;
    },
    [range, actionFilter, userIdFilter],
  );

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetch(buildUrl(null), { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || body.message || t("activity.error.loadHttp", { status: res.status }));
        }
        return res.json() as Promise<ActivityResponse>;
      })
      .then((res) => {
        setEvents(res.events);
        setScope(res.scope);
        setCursor(res.nextCursor);
        setHasMore(res.hasMore);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("activity.error.loadGeneric")))
      .finally(() => setLoading(false));
  }, [buildUrl, t]);

  function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    fetch(buildUrl(cursor), { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || body.message || t("activity.error.loadHttp", { status: res.status }));
        }
        return res.json() as Promise<ActivityResponse>;
      })
      .then((res) => {
        // Cursor pagination on a stable (created_at, id) order — appending
        // never re-fetches a row already in `events`, so no dupes/gaps as
        // long as the filter/range state hasn't changed since the first page.
        setEvents((prev) => [...prev, ...res.events]);
        setCursor(res.nextCursor);
        setHasMore(res.hasMore);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("activity.error.loadGeneric")))
      .finally(() => setLoadingMore(false));
  }

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

    // Tenant-scoped by the same endpoint the users-page filter already uses
    // — a tenant admin's token restricts this to their own tenant, so the
    // dropdown can never offer another tenant's user to filter to.
    fetch("/api/users", { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: { id: string; email: string; name: string | null }[]) => {
        setUsers(rows.map((r) => ({ id: r.id, label: r.name || r.email })));
      })
      .catch(() => setUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (!authorized || notAdmin) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, notAdmin, range, actionFilter, userIdFilter]);

  if (!authorized) return null;

  if (notAdmin) {
    return (
      <AppShell active="activity" title={t("nav.activity")}>
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

  const filterControls = (
    <div className="flex items-center gap-2">
      <ActionFilter selected={actionFilter} onChange={setActionFilter} />
      <Select
        ariaLabel={t("activity.filter.userAriaLabel")}
        value={userIdFilter}
        onChange={setUserIdFilter}
        options={[{ value: "", label: t("activity.filter.allUsers") }, ...users.map((u) => ({ value: u.id, label: u.label }))]}
        className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card dark:bg-card py-1.5 px-3 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
      />
      <Select
        ariaLabel={t("analytics.filters.dateRangeAriaLabel")}
        value={range}
        onChange={(v) => setRange(v as Range)}
        options={(Object.keys(RANGE_LABEL_KEYS) as Range[]).map((r) => ({ value: r, label: t(RANGE_LABEL_KEYS[r]) }))}
        className="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-line bg-card dark:bg-card py-1.5 px-3 text-sm text-ink outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
      />
    </div>
  );

  return (
    <AppShell active="activity" title={t("nav.activity")} actions={filterControls}>
      {loading && <p className="text-sm text-slate">{t("common.loading")}</p>}
      {loadError && <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      {!loading && !loadError && (
        <>
          <p className="mb-6 text-sm text-slate">
            {scope?.type === "tenant"
              ? scope.tenantName
                ? t("activity.scope.tenantWithName", { tenant: scope.tenantName })
                : t("activity.scope.tenantWithoutName")
              : t("activity.scope.all")}
          </p>

          {events.length === 0 ? (
            <div className="dam-glass rounded-[14px] p-10 text-center shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
              <p className="text-sm font-medium text-ink">{t("activity.empty.title")}</p>
            </div>
          ) : (
            <div className="space-y-6">
              {groupByDay(events, t).map((group) => (
                <div key={group.label}>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate">{group.label}</h2>
                  <div className="dam-glass divide-y divide-line overflow-hidden rounded-[14px] shadow-[0_8px_24px_rgba(0,46,92,0.10)]">
                    {group.events.map((e) => (
                      <EventRow key={e.id} event={e} showTenant={isSuperAdmin} />
                    ))}
                  </div>
                </div>
              ))}

              <div className="flex justify-center pt-2">
                {hasMore ? (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="cursor-pointer rounded-[8px] border border-line bg-card px-4 py-2 text-sm font-medium text-ink hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loadingMore ? t("common.loading") : t("activity.pagination.loadMore")}
                  </button>
                ) : (
                  <p className="text-xs text-slate">{t("activity.pagination.noMore")}</p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
