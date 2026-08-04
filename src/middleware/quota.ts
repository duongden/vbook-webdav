import { Context, Next } from 'hono';
import { Env, UserConfig } from '../types';
import { sanitizeObjectKey } from '../webdav/handler';

export const quotaMiddleware = async (c: Context<{ Bindings: Env; Variables: { user: UserConfig; username: string; uploadedObj?: R2Object } }>, next: Next) => {
  if (c.req.path.startsWith('/admin')) {
    return next();
  }

  const method = c.req.method;

  // We only check quota on upload methods like PUT.
  // We don't block DELETE or GET.
  if (method !== 'PUT') {
    return next();
  }

  const user = c.get('user');
  const username = c.get('username');

  // 1. Max File Size Check (pre-flight via Content-Length)
  const contentLength = Number(c.req.header('Content-Length') || 0);
  const maxFileSizeBytes = (user.max_file_size_mb || 50) * 1024 * 1024;

  if (contentLength > maxFileSizeBytes) {
    return c.text('Payload Too Large', 413);
  }

  // 2. Get Safe objectKey via sanitizeObjectKey
  let p = c.req.path.replace(/^\/webdav/, '');
  if (!p.startsWith('/')) p = '/' + p;
  const objectKey = sanitizeObjectKey(username, p);
  if (objectKey === null) {
    return c.text('Forbidden', 403);
  }

  // 3. Total Quota Check (pre-flight using KV cache)
  const usageKey = `usage:${username}`;
  let currentUsageBytes = 0;
  
  const cachedUsage = await c.env.USER_KV.get(usageKey);
  if (cachedUsage !== null) {
    currentUsageBytes = parseInt(cachedUsage, 10) || 0;
  } else {
    // Cache miss — fallback to listing R2 and seed the KV
    const prefix = `${username}/`;
    let listOptions: R2ListOptions = { prefix };
    let listed;
    do {
      listed = await c.env.STORAGE_R2.list(listOptions);
      for (const object of listed.objects) {
        currentUsageBytes += object.size;
      }
      listOptions.cursor = listed.truncated ? listed.cursor : undefined;
    } while (listed.truncated);
    
    // Seed the cache
    await c.env.USER_KV.put(usageKey, currentUsageBytes.toString());
  }

  // If overwriting, subtract the existing file's size so we don't overcalculate.
  const existingObj = await c.env.STORAGE_R2.head(objectKey);
  const existingSize = existingObj ? existingObj.size : 0;
  currentUsageBytes -= existingSize;

  const quotaBytes = (user.quota_mb || 500) * 1024 * 1024;

  if (currentUsageBytes + contentLength > quotaBytes) {
    return c.text('Insufficient Storage', 507);
  }

  await next();

  // 4. Post-upload incremental quota update
  // Check if response indicates success (201 Created)
  if (c.res.status === 201) {
    const uploadedObj = c.get('uploadedObj');
    if (uploadedObj) {
      const actualSize = uploadedObj.size;
      const newUsageBytes = Math.max(0, currentUsageBytes + actualSize);
      await c.env.USER_KV.put(usageKey, newUsageBytes.toString());
    }
  }
};
