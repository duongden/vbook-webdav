import { Hono, Context } from 'hono';
import { AppEnv, BookMetadata } from '../types';
import { getBookMetadata, metadataStorageRequest } from '../storage/client';
import { encodePath, sanitizeObjectKey } from '../utils/path';
import { bodyLimit } from 'hono/body-limit';

function sameOriginMutation(c: Context<AppEnv>): boolean {
  if (c.req.header('X-VBook-Action') !== 'metadata') return false;
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

function metadataPath(username: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 1024) return null;
  const key = sanitizeObjectKey(username, encodePath(`/${value}`));
  if (!key || !key.startsWith(`${username}/library/`) || key.endsWith('/')) return null;
  return key;
}

export const metadataApi = new Hono<AppEnv>();
metadataApi.use('*', bodyLimit({ maxSize: 16_384, onError: c => c.text('Payload Too Large', 413) }));

metadataApi.get('/', async c => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ records: await getBookMetadata(c.env, c.get('username')) });
});

metadataApi.put('/', async c => {
  if (!sameOriginMutation(c)) return c.text('Forbidden', 403);
  let body: Record<string, unknown>;
  try { body = await jsonBody(c); } catch { return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400); }
  const path = metadataPath(c.get('username'), body.path);
  if (!path) return c.json({ error: 'Chỉ có thể sửa tệp nằm trong library/.' }, 400);
  if (!await c.env.STORAGE_R2.head(path)) return c.json({ error: 'Tệp không còn tồn tại.' }, 404);
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return c.json({ error: 'Thông tin sách không hợp lệ.' }, 400);
  const response = await metadataStorageRequest(c.env, c.get('username'), 'metadata-put', { path, metadata: metadata as BookMetadata });
  if (!response.ok) return c.json({ error: 'Kiểm tra tên, mã ngôn ngữ và URL bìa HTTPS.' }, response.status === 400 ? 400 : 503);
  return c.json(await response.json());
});

metadataApi.delete('/', async c => {
  if (!sameOriginMutation(c)) return c.text('Forbidden', 403);
  let body: Record<string, unknown>;
  try { body = await jsonBody(c); } catch { return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400); }
  const path = metadataPath(c.get('username'), body.path);
  if (!path) return c.json({ error: 'Chỉ có thể sửa tệp nằm trong library/.' }, 400);
  const response = await metadataStorageRequest(c.env, c.get('username'), 'metadata-delete', { path });
  if (!response.ok) return c.json({ error: 'Không thể khôi phục dữ liệu nguồn.' }, 503);
  return new Response(null, { status: 204 });
});
