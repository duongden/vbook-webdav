import { Context, Next } from 'hono';
import { AppEnv, UserConfig } from '../types';
import { validUsername } from '../utils/path';
import { hashPassword, verifyPassword, generateSalt } from '../utils/crypto';

export const userAuthMiddleware = async (c: Context<AppEnv>, next: Next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
    return c.text('Unauthorized', 401);
  }

  const base64Credentials = authHeader.substring(6);
  try {
    const bytes = Uint8Array.from(atob(base64Credentials), char => char.charCodeAt(0));
    const credentials = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    // Only split on the FIRST colon — passwords may contain colons
    const colonIndex = credentials.indexOf(':');
    if (colonIndex === -1) {
      return c.text('Bad Request', 400);
    }
    const username = credentials.substring(0, colonIndex);
    const password = credentials.substring(colonIndex + 1);

    if (!validUsername(username) || !password) {
      return c.text('Bad Request', 400);
    }

    const userConfigStr = await c.env.USER_KV.get(`user:${username}`);
    // SECURITY (VULN-07): Always return the same generic error to prevent username enumeration
    if (!userConfigStr) {
      c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
      return c.text('Unauthorized', 401);
    }

    const userConfig = JSON.parse(userConfigStr) as UserConfig;
    if (userConfig.status !== 'active') {
      // Return 401 (not 403) to avoid leaking that the account exists but is suspended
      c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
      return c.text('Unauthorized', 401);
    }

    // SECURITY (VULN-01): Support both PBKDF2-hashed (new) and plain-text legacy accounts
    let passwordValid = false;
    if (userConfig.salt) {
      // Modern account: verify using PBKDF2
      passwordValid = await verifyPassword(password, userConfig.password_hash, userConfig.salt);
    } else {
      // Legacy account: plain-text comparison (will be upgraded on successful login)
      passwordValid = userConfig.password_hash === password;
    }

    if (!passwordValid) {
      c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
      return c.text('Unauthorized', 401);
    }

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
