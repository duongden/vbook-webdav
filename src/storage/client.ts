import type { Env, UserConfig } from '../types';
import { validUsername } from '../utils/path';

export function storageRequest(env: Env, username: string, action: string, options: {
  key?: string;
  request?: Request;
  user?: UserConfig;
} = {}): Promise<Response> {
  if (!validUsername(username)) throw new Error('Invalid storage owner');
  const headers = new Headers({ 'X-Storage-User': username });
  if (options.key) headers.set('X-Storage-Key', encodeURIComponent(options.key));
  if (options.user) {
    headers.set('X-Quota-MB', String(options.user.quota_mb));
    headers.set('X-Max-File-MB', String(options.user.max_file_size_mb));
  }
  const request = options.request;
  for (const name of action === 'put' ? ['Content-Length', 'Content-Type'] : []) {
    const value = request?.headers.get(name);
    if (value !== null && value !== undefined) headers.set(name, value);
  }
  return env.USER_STORAGE.get(env.USER_STORAGE.idFromName(`user:${username}`)).fetch(
    `https://storage.internal/${action}`,
    { method: action === 'usage' ? 'GET' : 'POST', headers, body: action === 'put' ? request?.body : undefined },
  );
}

export async function getUsage(env: Env, username: string): Promise<number> {
  const response = await storageRequest(env, username, 'usage');
  if (!response.ok) throw new Error('Storage accounting unavailable');
  return (await response.json<{ bytes: number }>()).bytes;
}
