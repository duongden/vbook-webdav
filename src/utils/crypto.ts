/**
 * Password hashing utilities using Web Crypto API (PBKDF2).
 * Available natively in Cloudflare Workers – no external dependencies needed.
 *
 * Strategy:
 *  - New passwords: PBKDF2-SHA256 with a random 16-byte salt, 1,000 iterations (legacy CPU-budget setting; not a strong offline-attack work factor).
 *  - Legacy accounts (no `salt` field): plain-text comparison (backward compat).
 *    On first successful login, the password is automatically re-hashed.
 */

const PBKDF2_ITERATIONS = 1_000;
const HASH_LENGTH_BITS = 256;

/** Generate a cryptographically random hex salt. */
export function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hash a plain-text password with the given hex salt using PBKDF2-SHA256. */
export async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_LENGTH_BITS
  );
  // Encode as base64 string for compact storage in KV
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

/**
 * Verify a plain-text password against a stored hash+salt.
 * Uses a constant-time comparison to prevent timing attacks.
 */
export async function verifyPassword(password: string, storedHash: string, salt: string): Promise<boolean> {
  const candidateHash = await hashPassword(password, salt);

  // Constant-time comparison: compare every byte to prevent timing side-channels
  if (candidateHash.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidateHash.length; i++) {
    diff |= candidateHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}
