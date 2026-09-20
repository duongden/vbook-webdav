import type { BookMetadataRecord, Env, UserConfig } from '../types';
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

export function shareStorageRequest(env: Env, username: string, action: string, fields: Record<string, string> = {}): Promise<Response> {
  if (!validUsername(username)) throw new Error('Invalid storage owner');
  const headers = new Headers({ 'X-Storage-User': username });
  for (const [name, value] of Object.entries(fields)) headers.set(name, value);
  return env.USER_STORAGE.get(env.USER_STORAGE.idFromName(`user:${username}`)).fetch(
    `https://storage.internal/${action}`,
    { method: action === 'share-list' ? 'GET' : 'POST', headers },
  );
}

export function metadataStorageRequest(env: Env, username: string, action: 'metadata-list' | 'metadata-put' | 'metadata-delete', body?: Record<string, unknown>): Promise<Response> {
  if (!validUsername(username)) throw new Error('Invalid storage owner');
  return env.USER_STORAGE.get(env.USER_STORAGE.idFromName(`user:${username}`)).fetch(
    `https://storage.internal/${action}`,
    {
      method: action === 'metadata-list' ? 'GET' : 'POST',
      headers: { 'X-Storage-User': username, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
}

export async function getBookMetadata(env: Env, username: string): Promise<BookMetadataRecord[]> {
  const response = await metadataStorageRequest(env, username, 'metadata-list');
  if (!response.ok) throw new Error('Book metadata unavailable');
  return (await response.json<{ records: BookMetadataRecord[] }>()).records;
}
