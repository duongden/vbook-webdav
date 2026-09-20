import { Context, Next } from 'hono';
import { AppEnv, UserConfig } from '../types';
import { validUsername } from '../utils/path';
import { hashPassword, verifyPassword, generateSalt } from '../utils/crypto';

const MAX_AUTH_ATTEMPTS = 8;
const AUTH_LOCK_SECONDS = 15 * 60;
const DUMMY_SALT = '00000000000000000000000000000000';

type AuthAttempts = { count: number; until: number };

function unauthorized(c: Context<AppEnv>, status: 401 | 429 = 401): Response {
  c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
  c.header('Cache-Control', 'private, no-store');
  if (status === 429) c.header('Retry-After', String(AUTH_LOCK_SECONDS));
  return c.text('Unauthorized', status);
}

async function authRateKey(c: Context<AppEnv>, username: string): Promise<string> {
  const address = c.req.header('CF-Connecting-IP') || 'local';
  const bytes = new TextEncoder().encode(`${address}\0${username}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `ratelimit:user:${Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function readAttempts(c: Context<AppEnv>, key: string): Promise<AuthAttempts> {
  try {
    const value = await c.env.USER_KV.get<AuthAttempts>(key, 'json');
    return value && Number.isFinite(value.count) && Number.isFinite(value.until) ? value : { count: 0, until: 0 };
  } catch { return { count: 0, until: 0 }; }
}

export const userAuthMiddleware = async (c: Context<AppEnv>, next: Next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
    return c.text('Unauthorized', 401);
  }

  const base64Credentials = authHeader.substring(6);
  try {
    if (base64Credentials.length > 2048) return c.text('Bad Request', 400);
    const bytes = Uint8Array.from(atob(base64Credentials), char => char.charCodeAt(0));
    const credentials = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    // Only split on the FIRST colon — passwords may contain colons
    const colonIndex = credentials.indexOf(':');
    if (colonIndex === -1) {
      return c.text('Bad Request', 400);
    }
    const username = credentials.substring(0, colonIndex);
    const password = credentials.substring(colonIndex + 1);

    if (!validUsername(username) || !password || password.length > 256) {
      return c.text('Bad Request', 400);
    }

    const rateKey = await authRateKey(c, username);
    const attempts = await readAttempts(c, rateKey);
    if (attempts.count >= MAX_AUTH_ATTEMPTS && attempts.until > Date.now()) return unauthorized(c, 429);

    const userConfigStr = await c.env.USER_KV.get(`user:${username}`);
    const userConfig = userConfigStr ? JSON.parse(userConfigStr) as UserConfig : null;

    // Missing, suspended and invalid accounts perform comparable PBKDF2 work and return one response.
    let passwordValid = false;
    if (!userConfig) {
      await hashPassword(password, DUMMY_SALT);
    } else if (userConfig.salt) {
      passwordValid = await verifyPassword(password, userConfig.password_hash, userConfig.salt);
    } else {
      await hashPassword(password, DUMMY_SALT);
      passwordValid = userConfig.password_hash === password;
    }

    if (!passwordValid || userConfig?.status !== 'active') {
      const count = attempts.count + 1;
      const until = count >= MAX_AUTH_ATTEMPTS ? Date.now() + AUTH_LOCK_SECONDS * 1000 : 0;
      c.executionCtx.waitUntil(c.env.USER_KV.put(rateKey, JSON.stringify({ count, until }), { expirationTtl: AUTH_LOCK_SECONDS }));
      return unauthorized(c, count >= MAX_AUTH_ATTEMPTS ? 429 : 401);
    }

    if (attempts.count > 0) c.executionCtx.waitUntil(c.env.USER_KV.delete(rateKey));

    // SECURITY (VULN-01): Auto-upgrade legacy plain-text passwords to PBKDF2 on first login
    if (!userConfig.salt) {
      const salt = generateSalt();
      const newHash = await hashPassword(password, salt);
      const upgraded: UserConfig = { ...userConfig, password_hash: newHash, salt };
      // Fire-and-forget — don't block the request on this write
      c.executionCtx.waitUntil(
        c.env.USER_KV.put(`user:${username}`, JSON.stringify(upgraded))
      );
      c.set('user', upgraded);
    } else {
      c.set('user', userConfig);
    }

    c.set('username', username);
  } catch (err) {
    return c.text('Bad Request', 400);
  }
  await next();
};
