import { describe, expect, it } from 'vitest';
import { isUuid } from './session';
import { validatePasswordStrength } from './users';
import { AppError } from './errors';
import { mailConfigured } from './mail';
import { readSessionToken, SESSION_COOKIE } from './sessionCookie';
import { clientIp } from './rateLimit';
import {
  sqlAccessibleCollectionsCte,
  sqlResourceAccessibleExists,
} from './permissions';

describe('isUuid', () => {
  it('accepts a v4 uuid', () => {
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });
  it('rejects non-uuids', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('validatePasswordStrength', () => {
  it('rejects a weak password', () => {
    expect(() => validatePasswordStrength('password')).toThrow(AppError);
  });
  it('accepts a strong password', () => {
    expect(() => validatePasswordStrength('GoodPass1!')).not.toThrow();
  });
});

describe('mailConfigured', () => {
  it('is false without SMTP env', () => {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    expect(mailConfigured()).toBe(false);
    if (user !== undefined) process.env.SMTP_USER = user;
    if (pass !== undefined) process.env.SMTP_PASS = pass;
  });
});

describe('readSessionToken', () => {
  it('reads the session cookie', () => {
    const req = new Request('http://localhost/api/x', {
      headers: { cookie: `${SESSION_COOKIE}=abc.def.ghi` },
    });
    expect(readSessionToken(req)).toBe('abc.def.ghi');
  });
  it('prefers Authorization Bearer', () => {
    const req = new Request('http://localhost/api/x', {
      headers: {
        authorization: 'Bearer from-header',
        cookie: `${SESSION_COOKIE}=from-cookie`,
      },
    });
    expect(readSessionToken(req)).toBe('from-header');
  });
});

describe('clientIp', () => {
  it('uses the first x-forwarded-for hop', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(clientIp(req)).toBe('1.2.3.4');
  });
});

describe('access SQL fragments', () => {
  it('bind tenant as $1 in the accessible CTE', () => {
    const sql = sqlAccessibleCollectionsCte(1);
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('WITH RECURSIVE root_finder');
  });
  it('does not interpolate a resource id string', () => {
    const sql = sqlResourceAccessibleExists('r.id', 2);
    expect(sql).toContain('cr3.resource_id = r.id');
    expect(sql).toContain('tenant_id = $2');
  });
});
