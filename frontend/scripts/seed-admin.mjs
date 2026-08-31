// Bootstraps a usable install: applies the reference data every environment
// needs (the `roles` rows, whose ids are load-bearing), then creates a single
// super-admin account to log in with.
//
//   node scripts/seed-admin.mjs --email you@example.com
//   node scripts/seed-admin.mjs --email you@example.com --password 'Sw0rdfish!'
//   node scripts/seed-admin.mjs --email you@example.com --reset-password
//
// With no --password, a strong one is generated and printed once.
// --reset-password updates an existing account's password instead of failing.
//
// This is the only supported way to create the FIRST account: public
// registration was deleted in Stage 105, and every other path to a user runs
// through POST /api/invitations/redeem, which needs an existing admin to send
// the invitation. A fresh database has no way to bootstrap itself without this.
//
// Runs against DIRECT_DATABASE_URL when set (the non-pooled endpoint), falling
// back to DATABASE_URL — same rule as scripts/migrate.mjs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = path.join(__dirname, '..', '..', 'db', 'seeds');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch {
  // No .env.local (CI, or a server) — rely on the real environment.
}

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Neither DIRECT_DATABASE_URL nor DATABASE_URL is set.');
  process.exit(1);
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : undefined;
}

const email = (arg('email') || '').trim().toLowerCase();
const resetPassword = process.argv.includes('--reset-password');
let password = arg('password');

if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/seed-admin.mjs --email <address> [--password <pw>] [--reset-password]');
  process.exit(1);
}

// Mirrors validatePasswordStrength() in lib/users.ts. Duplicated deliberately:
// that module imports lib/db and the whole AppError chain, which this
// standalone script has no reason to pull in — but the rule must not drift, so
// any change there belongs here too.
function validatePasswordStrength(pw) {
  return (
    pw.length >= 8 &&
    /[A-Z]/.test(pw) &&
    /[a-z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    /[^A-Za-z0-9]/.test(pw)
  );
}

// Generates a password that satisfies the rule by construction rather than by
// retrying until a random string happens to pass.
function generatePassword() {
  const pick = (set, n) =>
    Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  const chars =
    pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 3) +
    pick('abcdefghijkmnopqrstuvwxyz', 6) +
    pick('23456789', 3) +
    pick('!@#$%^&*-_=+', 2);
  // Fisher-Yates, so the character classes are not in a predictable order.
  const a = chars.split('');
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.join('');
}

let generated = false;
if (!password) {
  password = generatePassword();
  generated = true;
} else if (!validatePasswordStrength(password)) {
  console.error(
    'Password too weak. Needs 8+ characters with an uppercase letter, a lowercase letter, a number, and a special character.',
  );
  process.exit(1);
}

const pool = new Pool({ connectionString, connectionTimeoutMillis: 20_000, max: 1 });

async function main() {
  // Reference data first: users.role_id has a foreign key to roles, so the
  // insert below fails without it on a fresh database.
  if (fs.existsSync(SEEDS_DIR)) {
    for (const f of fs.readdirSync(SEEDS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
      await pool.query(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8'));
      console.log(`  seeded   ${f}`);
    }
  }

  const roles = await pool.query('SELECT count(*)::int AS n FROM roles');
  if (roles.rows[0].n === 0) {
    console.error('roles table is empty after seeding — cannot create a user.');
    process.exit(1);
  }

  const existing = await pool.query('SELECT id, role_id FROM users WHERE email = $1', [email]);
  const hash = await bcrypt.hash(password, 10);

  if (existing.rowCount > 0) {
    if (!resetPassword) {
      console.error(
        `\nA user with ${email} already exists (role_id ${existing.rows[0].role_id}).\n` +
          'Re-run with --reset-password to set a new password on it, or use a different --email.',
      );
      process.exit(1);
    }
    await pool.query(
      `UPDATE users
          SET password_hash = $1, role_id = 1, status = 'approved', email_verified = true,
              tenant_id = NULL, can_access_all_tenants = true, can_invite = true
        WHERE email = $2`,
      [hash, email],
    );
    console.log(`\n  updated  ${email} — password reset, role forced to super_admin`);
  } else {
    // A super admin deliberately has NO tenant: lib/session.ts treats role 1 as
    // unconditionally cross-tenant, and every tenant-scoped list route reads the
    // acting tenant from the switcher rather than from this column.
    await pool.query(
      `INSERT INTO users
         (email, password_hash, name, status, email_verified, tenant_id, role_id,
          can_access_all_tenants, can_invite)
       VALUES ($1, $2, $3, 'approved', true, NULL, 1, true, true)`,
      [email, hash, arg('name') || 'Super Admin'],
    );
    console.log(`\n  created  ${email} — super_admin (role 1), no tenant`);
  }

  console.log('\n----------------------------------------------------------');
  console.log(`  email     ${email}`);
  console.log(`  password  ${password}${generated ? '   <-- generated, shown once' : ''}`);
  console.log('----------------------------------------------------------');
  if (generated) console.log('  Save it now. It is not stored anywhere in plaintext.');
  console.log('  Change it after first login via Profile -> Password.\n');
}

main()
  .catch((err) => {
    console.error('\nFailed:', err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
