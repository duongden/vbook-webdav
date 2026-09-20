import { Hono, Context } from 'hono';
import { AppEnv, PublicWebDavShare, UserConfig } from '../types';
import { normalizeSharePrefix, scopedObjectKey, validUsername } from '../utils/path';
import { shareStorageRequest } from '../storage/client';
import { readWebDav } from './handler';
import { bodyLimit } from 'hono/body-limit';

const SHARE_ID = /^[A-Za-z0-9_-]{20,64}$/;
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function unauthorized(c: Context<AppEnv>): Response {
  c.header('WWW-Authenticate', 'Basic realm="VBook shared library", charset="UTF-8"');
  c.header('Cache-Control', 'private, no-store');
  return c.text('Unauthorized', 401);
}

function basicCredentials(header: string | undefined): { username: string; password: string } | null {
  if (!header || !/^Basic /i.test(header)) return null;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), character => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch { return null; }
}

async function sharedHandler(c: Context<AppEnv>): Promise<Response> {
  const owner = c.req.param('owner') || '';
  const shareId = c.req.param('shareId') || '';
  if (!validUsername(owner) || !SHARE_ID.test(shareId)) return unauthorized(c);
  const credentials = basicCredentials(c.req.header('Authorization'));
  if (!credentials || credentials.username !== 'reader' || !credentials.password) return unauthorized(c);

  const account = await c.env.USER_KV.get<UserConfig>(`user:${owner}`, 'json');
  if (!account || account.status !== 'active') return unauthorized(c);
  const verified = await shareStorageRequest(c.env, owner, 'share-auth', {
    'X-Share-Id': shareId,
    'X-Share-Secret-Hash': await digest(credentials.password),
  });
  if (!verified.ok) return unauthorized(c);
  const share = await verified.json<PublicWebDavShare>();

  const pathname = new URL(c.req.url).pathname;
  const basePath = `/shared/${owner}/${shareId}`;
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return c.text('Not Found', 404);
  const rawRelativePath = pathname.substring(basePath.length) || '/';
  const objectKey = scopedObjectKey(owner, share.prefix, rawRelativePath);
  if (!objectKey) return c.text('Forbidden', 403);
  return readWebDav(c, {
    owner,
    rootKey: `${owner}/${share.prefix}`,
    mountPath: `${basePath}/`,
    writable: false,
  }, objectKey);
}

export const sharedApp = new Hono<AppEnv>();
sharedApp.all('/:owner/:shareId', sharedHandler);
sharedApp.all('/:owner/:shareId/*', sharedHandler);

function sameOriginMutation(c: Context<AppEnv>): boolean {
  if (c.req.header('X-VBook-Action') !== 'shares') return false;
  const origin = c.req.header('Origin');
  return !origin || origin === new URL(c.req.url).origin;
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.length > 16_384) throw new Error('Body too large');
  const value: unknown = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
  return value as Record<string, unknown>;
}

export const shareApi = new Hono<AppEnv>();
shareApi.use('*', bodyLimit({ maxSize: 16_384, onError: c => c.text('Payload Too Large', 413) }));

shareApi.get('/', async c => {
  const response = await shareStorageRequest(c.env, c.get('username'), 'share-list');
  if (!response.ok) return c.text('Share storage unavailable', 503);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await response.json<{ shares: PublicWebDavShare[] }>());
});

shareApi.post('/', async c => {
  if (!sameOriginMutation(c)) return c.text('Forbidden', 403);
  let body: Record<string, unknown>;
  try { body = await jsonBody(c); } catch { return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400); }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const prefix = normalizeSharePrefix(typeof body.prefix === 'string' ? body.prefix : '');
  const expiresAt = body.expiresAt === null || body.expiresAt === undefined || body.expiresAt === '' ? undefined : Number(body.expiresAt);
  if (!label || label.length > 80 || !prefix || (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))) {
    return c.json({ error: 'Tên, thư mục hoặc thời hạn chia sẻ không hợp lệ.' }, 400);
  }
  const id = randomToken(16);
  const password = randomToken(32);
  const response = await shareStorageRequest(c.env, c.get('username'), 'share-create', {
    'X-Share-Id': id,
    'X-Share-Label': encodeURIComponent(label),
    'X-Share-Prefix': encodeURIComponent(prefix),
    'X-Share-Secret-Hash': await digest(password),
    ...(expiresAt ? { 'X-Share-Expires': String(expiresAt) } : {}),
  });
  if (!response.ok) return c.json({ error: await response.text() }, response.status as 400 | 403 | 409 | 503);
  const share = await response.json<PublicWebDavShare>();
  return c.json({ share, connection: { url: `${new URL(c.req.url).origin}/shared/${c.get('username')}/${id}/`, username: 'reader', password } }, 201);
});

shareApi.post('/:id/rotate', async c => {
  if (!sameOriginMutation(c)) return c.text('Forbidden', 403);
  const id = c.req.param('id') || '';
  if (!SHARE_ID.test(id)) return c.text('Not Found', 404);
  const password = randomToken(32);
  const response = await shareStorageRequest(c.env, c.get('username'), 'share-rotate', {
    'X-Share-Id': id,
    'X-Share-Secret-Hash': await digest(password),
  });
  if (!response.ok) return c.text(response.status === 404 ? 'Not Found' : 'Share storage unavailable', response.status === 404 ? 404 : 503);
  return c.json({ connection: { url: `${new URL(c.req.url).origin}/shared/${c.get('username')}/${id}/`, username: 'reader', password } });
});

shareApi.delete('/:id', async c => {
  if (!sameOriginMutation(c)) return c.text('Forbidden', 403);
  const id = c.req.param('id') || '';
  if (!SHARE_ID.test(id)) return c.text('Not Found', 404);
  const response = await shareStorageRequest(c.env, c.get('username'), 'share-revoke', { 'X-Share-Id': id });
  if (!response.ok) return c.text(response.status === 404 ? 'Not Found' : 'Share storage unavailable', response.status === 404 ? 404 : 503);
  return new Response(null, { status: 204 });
});
