import { Hono } from 'hono';
import type { AppEnv, UserConfig } from '../types';
import { shareStorageRequest } from '../storage/client';
import { encodePath, sanitizeObjectKey, validUsername } from '../utils/path';
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

/** Resolve repository assets without sending the bearer token to an external host. */
function assetUrl(value: unknown, owner: string, key: string, origin: string, mount: string): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  let rawPath: string;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
      const absolute = new URL(value, origin);
      if (absolute.origin !== origin || !absolute.pathname.startsWith('/webdav/vbookext/')) return value;
      rawPath = absolute.pathname.slice('/webdav'.length);
    } else if (value.startsWith('/webdav/vbookext/')) {
      rawPath = new URL(value, origin).pathname.slice('/webdav'.length);
    } else if (value.startsWith('/vbookext/') || value.startsWith('vbookext/')) {
      rawPath = new URL('/' + value.replace(/^\//, ''), origin).pathname;
    } else {
      const directory = key.slice(owner.length + 1, key.lastIndexOf('/') + 1);
      rawPath = new URL(value, origin + '/' + encodePath(directory)).pathname;
    }
    const target = sanitizeObjectKey(owner, rawPath);
    const root = owner + '/vbookext/';
    if (!target || !target.startsWith(root) || target.endsWith('/')) return value;
    return origin + mount + encodePath(target.slice(root.length));
  } catch { return value; }
}

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
  if (key.toLowerCase().endsWith('.json')) {
    const object = await c.env.STORAGE_R2.get(key);
    if (!object) return c.notFound();
    if (object.size > 2 * 1024 * 1024) return c.text('Extension repository JSON exceeds 2 MB', 413);
    const text = await object.text();
    let output = text;
    try {
      const manifest: unknown = JSON.parse(text);
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        const data = (manifest as Record<string, unknown>).data;
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const record = entry as Record<string, unknown>;
            for (const field of ['path', 'icon']) if (field in record) record[field] = assetUrl(record[field], owner, key, new URL(c.req.url).origin, mount);
          }
          output = JSON.stringify(manifest);
        }
      }
    } catch { /* Preserve non-repository JSON as uploaded. */ }
    const bytes = new TextEncoder().encode(output);
    return new Response(c.req.method === 'HEAD' ? null : bytes, { headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer',
    } });
  }
  return readWebDav(c, { owner, rootKey: `${owner}/vbookext/`, mountPath: mount, writable: false }, key);
});
