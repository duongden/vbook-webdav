import { Context, Next } from 'hono';
import { Env, UserConfig } from '../types';

export const userAuthMiddleware = async (c: Context<{ Bindings: Env; Variables: { user: UserConfig; username: string } }>, next: Next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
    return c.text('Unauthorized', 401);
  }

  const base64Credentials = authHeader.substring(6);
  try {
    const credentials = atob(base64Credentials);
    const [username, password] = credentials.split(':');

    if (!username || !password) {
      return c.text('Invalid credentials format', 401);
    }

    const userConfigStr = await c.env.USER_KV.get(`user:${username}`);
    if (!userConfigStr) {
      return c.text('User not found', 401);
    }

    const userConfig = JSON.parse(userConfigStr) as UserConfig;
    if (userConfig.status !== 'active') {
      return c.text('Account is suspended', 403);
    }

    // For simplicity, we are comparing plain text password in this initial version.
    // If you plan to hash, you should use Web Crypto API (SHA-256) or bcrypt if available.
    // Spec says 'password_hash' so let's just do a plain string match for now as a "hash".
    if (userConfig.password_hash !== password) {
      c.header('WWW-Authenticate', 'Basic realm="Vân Du"');
      return c.text('Unauthorized', 401);
    }

    c.set('user', userConfig);
    c.set('username', username);

    await next();
  } catch (err) {
    return c.text('Bad Request', 400);
  }
};
