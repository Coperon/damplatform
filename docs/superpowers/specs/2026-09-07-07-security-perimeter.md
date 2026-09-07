# Spec 07 — Security perimeter

**Date:** 2026-09-07  
**Status:** Draft for review  
**Parent:** [index](./2026-09-07-00-index.md)

Covers remaining security after Specs 03–04 and 06.

## Rate limiting

Keep Postgres `rate_limit_events`.

| Bucket | Limit | Window |
|---|---|---|
| login | 10 | 15 min |
| forgot-password | 5 | 15 min |
| reset-password | 10 | 15 min |
| invite-redeem | 10 | 15 min |
| email-change-confirm | 10 | 15 min |
| share-token | 60 | 1 min |
| share-file | 120 | 1 min |

IP: on Vercel, use the platform client IP (`x-forwarded-for` first hop as today, documented). Cap length 64. Fail-**open** on DB errors for availability; **log + SHOULD alert**. Do not fail-open silently without logs.

## Tokens

- Passwords: bcryptjs 10.
- Reset / invite / email-change / share **lookup** hashes: SHA-256 unique index.
- Share copy-link: AES-256-GCM with `SHARE_TOKEN_KEY` 32-byte key (keep).
- JWT_SECRET: min 32 bytes, validated at boot.

## Upload binding

Spec 06 pending_uploads. REQUIRED.

## Share original

`mode=original` and download require `accessLevel=download`. REQUIRED.

## SQL injection

Drizzle parameterized by default. Raw `sql` fragments only with bound params. No interpolating user ids into SQL identifiers except the existing allowlisted sort columns — keep a map, never string-concat user sort keys.

## XSS

React text encoding. No `dangerouslySetInnerHTML` for user content. Share gallery uses text nodes. Content-Type nosniff already in next.config.

## CSRF

Spec 04. SameSite=Lax.

## Secrets

`check-env` / boot: `DATABASE_URL`, `JWT_SECRET`, `S3_*`, `SHARE_TOKEN_KEY`, `APP_URL`. SMTP optional (features 503 if missing). Never log secrets, raw tokens, or passwords (`audit` metadata rule).

## Privilege escalation

- Tenant admin cannot assign `operator`.
- User cannot PATCH self to a higher role (keep self-edit block on admin user routes; profile route cannot change role).
- Last operator delete blocked (`FOR UPDATE` count operators).
- Invite role CHECK in DB.

## Public share

Token entropy 32 bytes. Unique hash. Revoke. Expiry. Scope check on every file GET.

## Object storage

Private bucket. Short-lived signed URLs. Keys not guessable (uuids). CORS on bucket limited to `APP_URL`.

## Headers

Keep existing security headers. Add `Content-Security-Policy` SHOULD (start with a strict default that does not break next/image or share pages).

## Logging of authz denials

Debug-level or audit only for repeated 403s — do not log token contents.

## Tests

Rate limit 429 after N logins. Share view original 403. Forged pendingId complete 403. Tenant admin invite operator 400.
