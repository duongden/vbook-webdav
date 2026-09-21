import { Hono, type Context } from 'hono';
import type { AppEnv, UserConfig } from '../types';
import { shareStorageRequest } from '../storage/client';
import { encodePath, sanitizeObjectKey, validUsername } from '../utils/path';
import { readWebDav } from './handler';

const SHORT_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const extensionApi = new Hono<AppEnv>();
extensionApi.post('/', async c => {
  if (c.req.header('X-VBook-Action') !== 'extensions' || (c.req.header('Origin') && c.req.header('Origin') !== new URL(c.req.url).origin)) return c.text('Forbidden', 403);
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const response = await shareStorageRequest(c.env, c.get('username'), 'extension-short-link', { 'X-Extension-Token': token });
  if (!response.ok) return c.text('Unavailable', 503);
  const stored = await response.text();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ baseUrl: `${new URL(c.req.url).origin}/s/${stored}/` });
});
extensionApi.delete('/', async c => {
  if (c.req.header('X-VBook-Action') !== 'extensions' || (c.req.header('Origin') && c.req.header('Origin') !== new URL(c.req.url).origin)) return c.text('Forbidden', 403);
  return shareStorageRequest(c.env, c.get('username'), 'extension-revoke');
});

/** Resolve repository assets without sending the bearer token to an external host. */
async function assetUrl(value: unknown, owner: string, key: string, origin: string, mount: string, lookup: (id: string) => Promise<string | null>): Promise<unknown> {
  if (typeof value !== 'string' || !value.trim()) return value;
  let rawPath: string;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
      const absolute = new URL(value, origin);
      if (absolute.origin !== origin) return value;
      const sharedPrefix = '/extensions/' + owner + '/';
      if (absolute.pathname.startsWith('/s/')) {
        const parts = absolute.pathname.slice(3).split('/');
        const id = parts.shift() || '';
        if (!SHORT_TOKEN.test(id) || await lookup(id) !== owner) return value;
        rawPath = '/vbookext/' + parts.join('/');
      } else if (absolute.pathname.startsWith(sharedPrefix)) {
        const remainder = absolute.pathname.slice(sharedPrefix.length);
        const slash = remainder.indexOf('/');
        if (slash < 0 || !TOKEN.test(remainder.slice(0, slash))) return value;
        // A saved repository may contain URLs issued before the owner rotated its link.
        rawPath = '/vbookext/' + remainder.slice(slash + 1);
      } else if (absolute.pathname.startsWith('/webdav/vbookext/')) {
        rawPath = absolute.pathname.slice('/webdav'.length);
      } else return value;
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
export const shortExtensionApp = new Hono<AppEnv>();
extensionApp.all('/:owner/:token/*', c => serveExtension(c, false));
shortExtensionApp.all('/:token/*', c => serveExtension(c, true));

async function serveExtension(c: Context<AppEnv>, short: boolean): Promise<Response> {
  c.header('Cache-Control', 'private, no-store');
  if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method Not Allowed', 405);
  const token = c.req.param('token') || '';
  if (!(short ? SHORT_TOKEN : TOKEN).test(token)) return c.notFound();
  const owner = short ? await c.env.USER_KV.get('extension-short:' + token) : c.req.param('owner');
  if (!owner || !validUsername(owner)) return c.notFound();
  const account = await c.env.USER_KV.get<UserConfig>(`user:${owner}`, 'json');
  if (!account || account.status !== 'active') return c.notFound();
  const verified = await shareStorageRequest(c.env, owner, short ? 'extension-short-auth' : 'extension-auth', { 'X-Extension-Token': token });
  if (!verified.ok) return c.notFound();
  const mount = short ? `/s/${token}/` : `/extensions/${owner}/${token}/`;
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
          const owners = new Map<string, Promise<string | null>>();
          const lookup = (id: string) => {
            let pending = owners.get(id);
            if (!pending) { pending = c.env.USER_KV.get('extension-short:' + id); owners.set(id, pending); }
            return pending;
          };
          for (const entry of data) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const record = entry as Record<string, unknown>;
            for (const field of ['path', 'icon']) if (field in record) record[field] = await assetUrl(record[field], owner, key, new URL(c.req.url).origin, mount, lookup);
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
}
