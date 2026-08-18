"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inter, Manrope } from "next/font/google";
import Select from "@/components/Select";
import { LOCALES, useTranslation, type Locale } from "@/lib/i18n";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"] });
const manrope = Manrope({ subsets: ["latin"], weight: ["600", "700"] });

// "profile" has no matching NAV_ITEMS entry — Profile is reached from the
// account menu, not the sidebar, so it's included here purely so
// app/profile/page.tsx can pass a valid `active` value; nothing in the
// sidebar ever highlights for it.
type ActiveSection =
  | "collections"
  | "media"
  | "users"
  | "metadata-fields"
  | "shares"
  | "tenants"
  | "analytics"
  | "activity"
  | "permissions"
  | "profile";

const SIDEBAR_COLLAPSE_KEY = "dam:sidebar:collapsed";
const THEME_KEY = "dam:theme";
const SIDEBAR_WIDTH_EXPANDED = 220;
const SIDEBAR_WIDTH_COLLAPSED = 64;

// Acting-tenant selection for cross-tenant-access (non-super-admin) users — stored in a
// cookie, not localStorage, because the browser then sends it on every API
// request automatically (the server's actingTenantId helper reads it) with no
// per-fetch-call-site wiring. The server honors it only for cross-tenant callers;
// anyone else's cookie is silently ignored server-side.
const ACTING_TENANT_COOKIE = "dam_acting_tenant";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readActingTenantCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)dam_acting_tenant=([^;]+)/);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  return UUID_RE.test(value) ? value : null;
}

function writeActingTenantCookie(tenantId: string) {
  document.cookie = `${ACTING_TENANT_COOKIE}=${encodeURIComponent(tenantId)}; path=/; max-age=31536000; samesite=lax`;
}

function clearActingTenantCookie() {
  document.cookie = `${ACTING_TENANT_COOKIE}=; path=/; max-age=0`;
}

// Minimal ambient typing for the View Transitions API — not yet in every
// TS lib target, and only ever accessed behind an `in` feature-detect below.
interface ViewTransition {
  ready: Promise<void>;
}
type DocumentWithViewTransitions = Document & {
  startViewTransition?: (callback: () => void) => ViewTransition;
};

interface AppShellProps {
  active: ActiveSection;
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

function parseToken(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}

// Accepts a name ("Georges Koueik") or an email ("georges.k@..."); splits on whitespace too
// so a real display name still yields two-letter initials, not just the email local-part.
function getInitials(value: string | null): string | null {
  if (!value) return null;
  const local = value.includes("@") ? value.split("@")[0] : value;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  if (local.length === 1) return local.toUpperCase();
  return null;
}

function CollectionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2.5 5.5A1.5 1.5 0 014 4h3.5l1.5 1.8H16A1.5 1.5 0 0117.5 7.3v7.2A1.5 1.5 0 0116 16H4a1.5 1.5 0 01-1.5-1.5v-9z" strokeLinejoin="round" />
    </svg>
  );
}

function MediaIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" strokeLinejoin="round" />
      <circle cx="7" cy="8" r="1.4" />
      <path d="M3 14.5l4-4 3 3 3.5-3.5L17 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="7.2" cy="6.5" r="2.5" />
      <path d="M2.5 16c0-2.5 2.1-4 4.7-4s4.7 1.5 4.7 4" strokeLinecap="round" />
      <path d="M13 5.2c1.2.2 2.1 1.2 2.1 2.5s-.9 2.3-2.1 2.5M14.8 12.2c1.7.4 2.8 1.6 2.8 3.3" strokeLinecap="round" />
    </svg>
  );
}

function MetadataFieldsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 5.5h14M3 10h14M3 14.5h8" strokeLinecap="round" />
      <circle cx="15.5" cy="14.5" r="1.4" />
    </svg>
  );
}

// Points left (collapse direction) when expanded, right (expand direction) when collapsed.
function CollapseToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      {collapsed ? (
        <path d="M7.5 4.5L13 10l-5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M12.5 4.5L7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M16.5 12.3A6.8 6.8 0 017.7 3.5a7 7 0 109.5 9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SharesIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="15" cy="5" r="2" />
      <circle cx="5" cy="10" r="2" />
      <circle cx="15" cy="15" r="2" />
      <path d="M6.8 9.1l6.4-3.2M6.8 10.9l6.4 3.2" strokeLinecap="round" />
    </svg>
  );
}

function TenantsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 16.5V5a1 1 0 011-1h5.5a1 1 0 011 1v11.5" strokeLinejoin="round" />
      <path d="M10.5 8.5H16a1 1 0 011 1v7" strokeLinejoin="round" />
      <path d="M5.5 6.8h1.5M5.5 9.3h1.5M5.5 11.8h1.5M12.8 11h1.5M12.8 13.5h1.5" strokeLinecap="round" />
      <path d="M2.5 16.5h15" strokeLinecap="round" />
    </svg>
  );
}

function AnalyticsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 16.5h14" strokeLinecap="round" />
      <path d="M5.5 16.5v-5M9.5 16.5V6.5M13.5 16.5v-8.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Same silhouette already used app-wide as the no-initials avatar fallback
// (this file's own account button below, and app/admin/users/page.tsx's
// getInitials fallback) — reused here as the account-menu "Profile" glyph
// so it reads as "you," consistent with every other avatar in the app.
function ProfileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 10a4 4 0 100-8 4 4 0 000 8zM2 18a8 8 0 1116 0H2z" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 5.5V10l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PermissionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 2.5l6 2.2v4.3c0 4-2.6 6.7-6 8-3.4-1.3-6-4-6-8V4.7l6-2.2z" strokeLinejoin="round" />
      <path d="M7.2 10l1.9 1.9 3.7-3.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5a11 11 0 010 15M10 2.5a11 11 0 000 15" strokeLinecap="round" />
    </svg>
  );
}

const NAV_ITEMS: {
  key: ActiveSection;
  labelKey: string;
  href: string;
  adminOnly: boolean;
  // Stage 6 (interim, reversed for Shares/Media below): a tenant admin also
  // has canAdmin: true (adminOnly alone no longer means "super admin only").
  // Companies/Metadata stay genuinely global — GET /api/tenants is still
  // requireSuperAdmin, and metadata field definitions are system-wide schema
  // — so those items additionally require it. Media no longer does: GET
  // /api/media is now tenant-scoped (a tenant admin sees only resources
  // their tenant can reach), so gating the nav item on isSuperAdmin would
  // show a working feature to nobody but super admins while 403ing a tenant
  // admin who clicks it — the same UI/server mismatch this pass fixed on
  // Import URL and Shares. Users management is another admin surface a
  // tenant admin keeps.
  superAdminOnly: boolean;
  icon: () => React.ReactNode;
}[] = [
  { key: "collections", labelKey: "nav.collections", href: "/home", adminOnly: false, superAdminOnly: false, icon: CollectionsIcon },
  { key: "tenants", labelKey: "nav.companies", href: "/admin/tenants", adminOnly: true, superAdminOnly: true, icon: TenantsIcon },
  { key: "media", labelKey: "nav.media", href: "/admin/media", adminOnly: true, superAdminOnly: false, icon: MediaIcon },
  { key: "users", labelKey: "nav.users", href: "/admin/users", adminOnly: true, superAdminOnly: false, icon: UsersIcon },
  { key: "analytics", labelKey: "nav.analytics", href: "/admin/analytics", adminOnly: true, superAdminOnly: false, icon: AnalyticsIcon },
  { key: "activity", labelKey: "nav.activity", href: "/admin/activity", adminOnly: true, superAdminOnly: false, icon: ActivityIcon },
  { key: "metadata-fields", labelKey: "nav.metadataFields", href: "/admin/metadata-fields", adminOnly: true, superAdminOnly: false, icon: MetadataFieldsIcon },
  { key: "shares", labelKey: "nav.shares", href: "/admin/shares", adminOnly: true, superAdminOnly: false, icon: SharesIcon },
  // Stage 108: both tenant admins (their own tenant) and super admins (any
  // tenant, picked in-page) manage the editor/viewer permission matrix here —
  // not super-admin-only, same tier as Users/Media/Analytics/Activity.
  { key: "permissions", labelKey: "nav.permissions", href: "/admin/permissions", adminOnly: true, superAdminOnly: false, icon: PermissionsIcon },
];

export default function AppShell({ active, title, actions, children }: AppShellProps) {
  const router = useRouter();
  const { t, locale, setLocale } = useTranslation();
  const [authorized, setAuthorized] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const themeToggleRef = useRef<HTMLButtonElement>(null);

  // Tenant switcher — cross-tenant-access (non-super-admin) users only. actingTenant is
  // whichever tenant they're currently navigating as; the topbar pill keeps
  // the selection visible at all times so it's never ambiguous whose data is
  // on screen.
  const [allTenantsNonSuper, setAllTenantsNonSuper] = useState(false);
  const [actingTenant, setActingTenant] = useState<string | null>(null);
  const [tenantOptions, setTenantOptions] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    // The anti-flash script in app/layout.tsx already applied the stored
    // theme to <html> before this ever mounts — read it back from the DOM
    // (the source of truth) rather than re-reading localStorage separately,
    // so this can never disagree with what's actually rendered.
    try {
      setDarkMode(document.documentElement.dataset.theme === "dark");
    } catch {
      setDarkMode(false);
    }
  }, []);

  function toggleDarkMode() {
    const next = !darkMode;

    const apply = () => {
      document.documentElement.dataset.theme = next ? "dark" : "light";
      setDarkMode(next);
      try {
        localStorage.setItem(THEME_KEY, next ? "dark" : "light");
      } catch {
        // ignore persistence failures (e.g. private browsing)
      }
    };

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as DocumentWithViewTransitions;
    const button = themeToggleRef.current;

    // Circular wipe from the toggle button's own coordinates, only when the
    // browser supports it and the user hasn't asked for reduced motion —
    // otherwise the flip is instant, which is the correct baseline (not a
    // degraded fallback): independently interpolating ~15 tokens produces a
    // contrast-dipping smear, and backdrop-filter can't interpolate anyway.
    if (doc.startViewTransition && !reduceMotion && button) {
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );

      const transition = doc.startViewTransition(apply);
      transition.ready.then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 450,
            easing: "ease-in-out",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      });
    } else {
      apply();
    }
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/");
      return;
    }
    const payload = parseToken(token);
    setIsAdmin(!!payload?.canAdmin);
    setIsSuperAdmin(payload?.roleName === "super_admin");

    // Tenant switcher setup — cross-tenant-access non-super-admin users only (a super
    // admin's views are already unscoped; the switcher is for role-2 admins
    // carrying the can_access_all_tenants flag). Default: their OWN tenant — switching
    // to another tenant is always an explicit choice, never a surprise.
    const isAllTenantsUser = payload?.canAccessAllTenants === true && payload?.roleName !== "super_admin";
    setAllTenantsNonSuper(isAllTenantsUser);
    if (isAllTenantsUser) {
      const ownTenant = typeof payload?.tenantId === "string" ? payload.tenantId : null;
      const fromCookie = readActingTenantCookie();
      const acting = fromCookie ?? ownTenant;
      if (acting) {
        if (!fromCookie) writeActingTenantCookie(acting);
        setActingTenant(acting);
      }
      fetch("/api/tenants", { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => (res.ok ? res.json() : []))
        .then((rows: { id: string; name: string }[]) => {
          if (Array.isArray(rows)) setTenantOptions(rows);
        })
        .catch(() => {
          // Non-fatal: the pill still shows the raw selection state; the
          // select just has no options to switch to.
        });
    }

    setUserEmail(typeof payload?.email === "string" ? payload.email : null);
    // Older tokens (issued before the "name" claim existed) simply won't have it —
    // falls back to email everywhere below.
    setUserName(typeof payload?.name === "string" && payload.name ? payload.name : null);
    setUserRole(typeof payload?.roleName === "string" ? payload.roleName : null);
    setAuthorized(true);

    // Sidebar collapse preference — an explicit stored choice always wins over
    // the role default (read/write localStorage only here, inside an effect,
    // never during render). With nothing stored yet, default collapsed for
    // viewers (no admin or upload permission) and expanded for everyone else;
    // canAdmin/canUpload are read here only to pick this default — nav item
    // gating below is untouched.
    try {
      const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
      if (stored === "true" || stored === "false") {
        setCollapsed(stored === "true");
      } else {
        const canAdminFlag = !!payload?.canAdmin;
        const canUploadFlag = !!payload?.canUpload;
        setCollapsed(!canAdminFlag && !canUploadFlag);
      }
    } catch {
      setCollapsed(false);
    }
  }, [router]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(next));
      } catch {
        // ignore persistence failures (e.g. private browsing)
      }
      return next;
    });
  }

  useEffect(() => {
    if (!menuOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  function handleSignOut() {
    localStorage.removeItem("token");
    // Never leave one user's acting-tenant selection behind for the next
    // login in the same browser.
    clearActingTenantCookie();
    router.push("/");
  }

  function handleActingTenantChange(tenantId: string) {
    if (!UUID_RE.test(tenantId)) return;
    writeActingTenantCookie(tenantId);
    setActingTenant(tenantId);
    // Full reload rather than router state: every page's already-fetched data
    // was scoped to the previous tenant — a reload refetches everything under
    // the new one, with no per-page wiring.
    window.location.reload();
  }

  if (!authorized) return null;

  const displayName = userName ?? userEmail ?? "Account";
  const initials = getInitials(userName || userEmail);

  return (
    <div className={`${inter.className} min-h-screen bg-content-base`}>
      {/* Frosted-glass surfaces shared by the top bar and (via app/home/page.tsx) the
          collection cards / search field. Plain CSS (not inline styles) so the
          @supports fallback can apply — browsers without backdrop-filter get an
          opaque background instead of a translucent one, so text never loses contrast. */}
      <style>{`
        /* .dam-glass / .dam-glass-topbar now live in globals.css (single
           canonical definition, no longer duplicated per-component). */

        /* Sidebar collapse/expand — width/margin/left are set inline (computed
           from collapsed state); this class only supplies the animation timing,
           so prefers-reduced-motion can cleanly turn it into an instant jump. */
        .dam-sidebar-shift {
          transition: width 200ms ease-in-out;
        }
        .dam-content-shift {
          transition: margin-left 200ms ease-in-out;
        }
        .dam-aurora-shift {
          transition: left 200ms ease-in-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .dam-sidebar-shift,
          .dam-content-shift,
          .dam-aurora-shift {
            transition: none;
          }
        }
      `}</style>

      {/* Sidebar — width is set inline (computed from collapsed state) so the
          collapse/expand animates via the .dam-sidebar-shift transition rule. */}
      <aside
        className="dam-sidebar-shift fixed left-0 top-0 z-30 flex h-screen flex-col bg-brand-dark"
        style={{ width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED }}
      >
        {/* overflow-hidden scoped to just this row — the wordmark logo is wider than
            the collapsed rail, and this is the only part of the sidebar that must clip;
            the account-menu popover further down needs to overflow past the rail width. */}
        <div
          className={`flex h-[60px] shrink-0 items-center overflow-hidden border-b border-white/10 ${
            collapsed ? "justify-center px-2" : "justify-between px-4"
          }`}
        >
          {collapsed ? (
            <img src="/icon.png" alt="Coperon Technologies" className="h-7 w-7 rounded" />
          ) : (
            <img
              src="/coperon-technologies.png"
              alt="Coperon Technologies"
              className="h-auto w-[130px]"
              style={{ filter: "brightness(0) invert(1)" }}
            />
          )}
          {!collapsed && (
            <button
              onClick={toggleCollapsed}
              aria-label={t("nav.collapseSidebar")}
              aria-expanded={true}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <CollapseToggleIcon collapsed={false} />
            </button>
          )}
        </div>

        {collapsed && (
          <div className="flex shrink-0 justify-center border-b border-white/10 py-2">
            <button
              onClick={toggleCollapsed}
              aria-label={t("nav.expandSidebar")}
              aria-expanded={false}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <CollapseToggleIcon collapsed={true} />
            </button>
          </div>
        )}

        <nav className={`flex-1 space-y-1 overflow-hidden py-4 ${collapsed ? "px-2" : "px-3"}`}>
          {NAV_ITEMS.filter((item) => (!item.adminOnly || isAdmin) && (!item.superAdminOnly || isSuperAdmin)).map((item) => {
            const isActive = item.key === active;
            const Icon = item.icon;
            const label = t(item.labelKey);
            return (
              <Link
                key={item.key}
                href={item.href}
                title={collapsed ? label : undefined}
                aria-label={label}
                className={`relative flex items-center rounded-lg py-2.5 text-sm font-medium transition-colors ${
                  collapsed ? "justify-center px-2" : "gap-3 px-3"
                }`}
                style={{
                  backgroundColor: isActive ? "rgba(255,255,255,0.12)" : "transparent",
                  color: isActive ? "#FFFFFF" : "rgba(255,255,255,0.72)",
                }}
              >
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-brand-light" />
                )}
                <Icon />
                {!collapsed && <span>{label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Account row */}
        <div className="relative shrink-0 border-t border-white/10 p-3">
          {menuOpen && (
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          )}

          {menuOpen && (
            <div className="absolute bottom-full left-3 z-20 mb-2 w-56 overflow-hidden rounded-lg border border-line bg-card shadow-lg">
              <div className="px-4 py-3">
                <p className="truncate text-sm font-medium text-ink">
                  {displayName}
                </p>
                {userRole && <p className="text-xs capitalize text-slate">{userRole}</p>}
              </div>
              <div className="border-t border-line" />
              <Link
                href="/profile"
                onClick={() => setMenuOpen(false)}
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-sm text-ink hover:bg-mist"
              >
                <ProfileIcon />
                {t("account.profile")}
              </Link>
              <div className="border-t border-line" />
              {/* Language selector — between Profile and the dark-mode toggle.
                  Labels are each language's own name ("Italiano", not
                  "Italian") so the current choice reads correctly regardless
                  of which language is active. Switching applies immediately,
                  no reload: setLocale (lib/i18n.tsx) updates the React
                  context synchronously, so every t()-driven string in the
                  tree re-renders in the new language on the same tick —
                  unlike the acting-tenant switcher below, there's no
                  server-scoped data to refetch. */}
              <div className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-sm text-ink">
                <span className="flex items-center gap-2">
                  <GlobeIcon />
                  {t("account.language")}
                </span>
                <Select
                  ariaLabel={t("account.language")}
                  value={locale}
                  onChange={(next) => setLocale(next as Locale)}
                  options={LOCALES.map((l) => ({ value: l.code, label: l.name }))}
                  className="flex cursor-pointer items-center justify-between gap-1.5 rounded-[8px] border border-line bg-card px-2.5 py-1 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                />
              </div>
              <div className="border-t border-line" />
              <button
                ref={themeToggleRef}
                onClick={toggleDarkMode}
                aria-pressed={darkMode}
                aria-label={darkMode ? t("account.switchToLight") : t("account.switchToDark")}
                className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm text-ink hover:bg-mist"
              >
                <span className="flex items-center gap-2">
                  {darkMode ? <SunIcon /> : <MoonIcon />}
                  {darkMode ? t("account.lightMode") : t("account.darkMode")}
                </span>
                <span
                  className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
                  style={{ backgroundColor: darkMode ? "var(--color-brand)" : "var(--color-input-border)" }}
                >
                  <span
                    className="inline-block h-3.5 w-3.5 transform rounded-full bg-card shadow transition-transform"
                    style={{ transform: darkMode ? "translateX(18px)" : "translateX(3px)" }}
                  />
                </span>
              </button>
              <div className="border-t border-line" />
              <button
                onClick={() => { setMenuOpen(false); handleSignOut(); }}
                className="block w-full cursor-pointer px-4 py-2.5 text-left text-sm text-ink hover:bg-mist"
              >
                {t("account.signOut")}
              </button>
            </div>
          )}

          <button
            onClick={() => setMenuOpen((v) => !v)}
            title={collapsed ? displayName : undefined}
            aria-label={displayName}
            className={`relative z-20 flex w-full cursor-pointer items-center overflow-hidden rounded-lg py-2 text-left transition-colors hover:bg-white/[0.08] ${
              collapsed ? "justify-center px-0" : "gap-2.5 px-2"
            }`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">
              {initials ?? (
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10 10a4 4 0 100-8 4 4 0 000 8zM2 18a8 8 0 1116 0H2z" />
                </svg>
              )}
            </span>
            {!collapsed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-white">
                  {displayName}
                </span>
                {userRole && (
                  <span className="block truncate text-[11px] capitalize text-white/60">{userRole}</span>
                )}
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* Decorative aurora blobs — sit behind the content area, pinned to the viewport, no tiling/animation */}
      <div
        aria-hidden="true"
        className="dam-aurora-shift pointer-events-none fixed inset-y-0 right-0 z-0 overflow-hidden"
        style={{
          left: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
          backgroundColor: "var(--color-content-base)",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -90,
            left: -90,
            width: 340,
            height: 340,
            borderRadius: "9999px",
            backgroundColor: "var(--color-brand)",
            opacity: "var(--aurora-opacity-1)",
            filter: "blur(70px)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -80,
            right: -80,
            width: 320,
            height: 320,
            borderRadius: "9999px",
            backgroundColor: "var(--color-brand-light)",
            opacity: "var(--aurora-opacity-2)",
            filter: "blur(75px)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -110,
            right: -60,
            width: 360,
            height: 360,
            borderRadius: "9999px",
            backgroundColor: "var(--color-brand-mid)",
            opacity: "var(--aurora-opacity-3)",
            filter: "blur(80px)",
          }}
        />
      </div>

      {/* Content column */}
      <div
        className="dam-content-shift relative z-10 flex min-h-screen flex-col"
        style={{ marginLeft: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED }}
      >
        <header className="dam-glass-topbar relative z-20 flex h-[64px] shrink-0 items-center justify-between gap-4 px-8">
          <div className={`${manrope.className} shrink-0 text-[18px] font-bold text-ink`}>
            {title}
          </div>
          <div className="flex min-w-0 items-center gap-3">
            {/* Acting-tenant switcher — cross-tenant-access non-super-admin users only.
                Lives in the shell's own topbar (not per-page actions) so the
                current selection is visible on every page, at all times —
                there is never a screen where it's ambiguous whose data is
                being shown. Amber accent so it reads as a mode, not a filter. */}
            {allTenantsNonSuper && (
              <div
                className="flex shrink-0 items-center gap-2 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 py-1 pl-3 pr-1"
                title="You have access to every company. All pages show this company's data."
              >
                <span className="whitespace-nowrap text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                  Acting as
                </span>
                <Select
                  ariaLabel="Acting as company"
                  value={actingTenant ?? ""}
                  onChange={handleActingTenantChange}
                  options={tenantOptions.map((t) => ({ value: t.id, label: t.name }))}
                  className="flex max-w-[180px] cursor-pointer items-center justify-between gap-1.5 rounded-full border border-line bg-card px-2 py-1 text-[12px] font-medium text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                />
              </div>
            )}
            {actions && <div className="flex items-center gap-3">{actions}</div>}
          </div>
        </header>

        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
