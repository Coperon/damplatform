import crypto from 'crypto';

// Symmetric, at-rest encryption for share tokens — lets an admin re-copy a
// share's link later (lib/shares.ts's bcrypt-hash validation path is
// completely separate and unaffected by this file; encryption here is for
// retrieval only, never for proving a client's token is correct).
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV, the size GCM is designed for
const KEY_LENGTH = 32; // AES-256

function getKey(): Buffer {
  const raw = process.env.SHARE_TOKEN_KEY;
  if (!raw) {
    throw new Error(
      'SHARE_TOKEN_KEY is not set. Generate one with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"` and set it in every environment that creates or reads shares.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `SHARE_TOKEN_KEY must decode (base64) to exactly ${KEY_LENGTH} bytes for AES-256; got ${key.length}.`,
    );
  }
  return key;
}

// Packs iv:authTag:ciphertext, each base64, into one string column value.
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

// Throws (never returns a silently-wrong plaintext) if the key is wrong or the
// stored value was tampered with/corrupted — GCM's auth tag check happens
// inside decipher.final() and rejects on mismatch.
export function decrypt(packed: string): string {
  const key = getKey();
  const parts = packed.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value: expected "iv:authTag:ciphertext"');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
