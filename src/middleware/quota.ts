import { Context, Next } from 'hono';
import { Env, UserConfig } from '../types';

export const quotaMiddleware = async (c: Context<{ Bindings: Env; Variables: { user: UserConfig; username: string } }>, next: Next) => {
  const method = c.req.method;

  // We only check quota on upload methods like PUT.
  // We don't block DELETE or GET.
  if (method !== 'PUT') {
    return next();
  }

  const user = c.get('user');
  const username = c.get('username');

  // 1. Max File Size Check
  const contentLength = Number(c.req.header('Content-Length') || 0);
  const maxFileSizeBytes = (user.max_file_size_mb || 50) * 1024 * 1024;
  
  if (contentLength > maxFileSizeBytes) {
    return c.text('Payload Too Large', 413);
  }

  // 2. Total Quota Check
  // We list all objects in the user's directory to calculate current usage.
  // Note: For a very large number of files, this might require pagination, 
  // but for personal backup, a single list request (limit 1000) is usually enough.
  const prefix = `${username}/`;
  let currentUsageBytes = 0;
  
  let listOptions: R2ListOptions = { prefix };
  let listed;
  do {
    listed = await c.env.STORAGE_R2.list(listOptions);
    for (const object of listed.objects) {
      currentUsageBytes += object.size;
    }
    listOptions.cursor = listed.truncated ? listed.cursor : undefined;
  } while (listed.truncated);

  // If overwriting, subtract the existing file's size so we don't overcalculate.
  let path = c.req.path.replace(/^\/webdav/, '');
  if (!path.startsWith('/')) path = '/' + path;
  const objectKey = path === '/' ? `${username}/` : `${username}${path}`;
  const existingObj = await c.env.STORAGE_R2.head(objectKey);
  if (existingObj) {
    currentUsageBytes -= existingObj.size;
  }

  const quotaBytes = (user.quota_mb || 500) * 1024 * 1024;

  if (currentUsageBytes + contentLength > quotaBytes) {
    return c.text('Insufficient Storage', 507);
  }

  await next();
};
