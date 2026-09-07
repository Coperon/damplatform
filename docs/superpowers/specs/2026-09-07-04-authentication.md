# Spec 04 — Authentication and sessions

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

## Session

- HS256 JWT in httpOnly cookie `dam_session`, `SameSite=Lax`, `Secure` when `APP_URL` is https or `VERCEL=1`, `Path=/`, max age 1 day.
- JWT payload is **identity only:** `sub`, `iat`, `exp`. No capability flags, no role, no tenantId in the token as an authorization source.
- Every authenticated request: verify JWT → load `users` by `sub` → if missing, disabled, or not `active`, 401 and clear cookie. Build `Principal` from the **row**.
- Role/tenant/status changes take effect on the next request without waiting for expiry.
- Bearer token still accepted for non-browser clients; same verify-then-load-user path. Browser app uses cookie + `credentials: 'same-origin'` only.

## Login

- Rate limit (Spec 07).
- Lookup by email, bcryptjs compare (cost 10).
- If no user or wrong password: generic 401, audit `login_failure` without revealing which.
- If `status !== 'active'`: generic 401 (do not say “disabled”).
- If success: mint JWT `{ sub }`, set cookie, audit `login_success`.
- Password strength unchanged: 8+ upper, lower, digit, special (`validatePasswordStrength`).

## Logout

Clear cookie. No auth required. Optional audit.

## Password reset / email change / invites

- Raw token: `crypto.randomBytes(32)`.
- Store **SHA-256 hex** (or hmac) of token, not bcrypt. Lookup by hash is O(1) unique index. Bcrypt remains for passwords only. Migrate invite/share verification from bcrypt compare-all to hash lookup.
- Reset: 30 min, single-use `usedAt`.
- Email change: 24h, atomic consume.
- Invite: 7 days, `id.raw` (or opaque) in URL, hash unique, consume in a transaction before insert user.
- Generic errors on invalid tokens.

## Email verification

Invite redeem sets `emailVerified = true` (email proved by token). If any other signup path appears later, it must verify before `active`.

## CSRF

Cookie session + `SameSite=Lax` + JSON API same-origin. No CSRF token required for this app’s current browser model. Do not set `SameSite=None` without CSRF tokens.

State-changing GET remains forbidden (email confirm stays POST).

## Middleware

- Pages: unauthenticated users redirected to `/` except public pages (login, forgot, reset, invite, share, confirm-email).
- Middleware may check cookie **presence** only (cannot load user in Edge easily without duplicating secrets). Real auth is `requireAuth` in server handlers and server components if any.
- API: middleware does not authorize. Handlers use `requireAuth` / public allowlist. A shared wrapper `withAuth` is required so a new route cannot forget.

## Public API allowlist (closed)

`POST /api/auth/login`, `forgot-password`, `reset-password`, `logout`  
`GET/POST` invitation validate/redeem  
`GET /api/share/*`  
`GET/POST` email-change validate/confirm  
`GET /api/health`

Everything else: authenticated or 401.

## Operator acting-tenant cookie

`dam_acting_tenant` should become **httpOnly** set via `POST /api/auth/acting-tenant` (operator only). Stop writing it from `document.cookie`.

## Tests

- Disabled user cannot login; existing JWT of disabled user is 401 on next `/api/auth/me`.
- Role change visible without re-login.
- JWT with forged `role: operator` claim is ignored (claim not read).
