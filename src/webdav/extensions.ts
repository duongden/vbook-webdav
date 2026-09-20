import { Hono } from 'hono';
import type { AppEnv, UserConfig } from '../types';
import { shareStorageRequest } from '../storage/client';
import { sanitizeObjectKey, validUsername } from '../utils/path';
import { readWebDav } from './handler';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const extensionApi = new Hono<AppEnv>();
extensionApi.post('/', async c => {
  if (c.req.header('X-VBook-Action') !== 'extensions' || (c.req.header('Origin') && c.req.header('Origin') !== new URL(c.req.url).origin)) return c.text('Forbidden', 403);
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const response = await shareStorageRequest(c.env, c.get('username'), 'extension-link', { 'X-Extension-Token': token });
  if (!response.ok) return c.text('Unavailable', 503);
  const stored = await response.text();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ baseUrl: `${new URL(c.req.url).origin}/extensions/${c.get('username')}/${stored}/` });
});
extensionApi.delete('/', async c => {
  if (c.req.header('X-VBook-Action') !== 'extensions' || (c.req.header('Origin') && c.req.header('Origin') !== new URL(c.req.url).origin)) return c.text('Forbidden', 403);
  return shareStorageRequest(c.env, c.get('username'), 'extension-revoke');
});

export const extensionApp = new Hono<AppEnv>();
extensionApp.all('/:owner/:token/*', async c => {
  c.header('Cache-Control', 'private, no-store');
  if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method Not Allowed', 405);
  const owner = c.req.param('owner');
  const token = c.req.param('token');
  if (!validUsername(owner) || !TOKEN.test(token)) return c.notFound();
  const account = await c.env.USER_KV.get<UserConfig>(`user:${owner}`, 'json');
  if (!account || account.status !== 'active') return c.notFound();
  const verified = await shareStorageRequest(c.env, owner, 'extension-auth', { 'X-Extension-Token': token });
  if (!verified.ok) return c.notFound();
  const mount = `/extensions/${owner}/${token}/`;
  const pathname = new URL(c.req.url).pathname;
  if (!pathname.startsWith(mount)) return c.notFound();
  const key = sanitizeObjectKey(owner, '/vbookext/' + pathname.slice(mount.length));
  if (!key || !key.startsWith(`${owner}/vbookext/`) || key.endsWith('/')) return c.notFound();
  return readWebDav(c, { owner, rootKey: `${owner}/vbookext/`, mountPath: mount, writable: false }, key);
});
