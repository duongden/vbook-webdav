import { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppEnv } from '../types';
import { encryptPassword, decryptPassword } from '../utils/password-vault';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
const MAX_DEPTH = 24;
const MAX_PAGES = 10;

interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

interface DriveListResponse {
  files?: DriveItem[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function safeDriveName(name: string): boolean {
  return Boolean(name) && !/[\/\\\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..';
}

export function extractDriveFolderId(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2048) return null;
  if (DRIVE_ID.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password) return null;
  const folder = url.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,100})(?:\/|$)/)?.[1];
  const open = url.pathname === '/open' ? url.searchParams.get('id') : null;
  const id = folder || open;
  return id && DRIVE_ID.test(id) ? id : null;
}

interface DriveConfig { folderId: string; encryptedKey: string }
function vaultSecret(c: Context<AppEnv>): string { return c.env.DRIVE_VAULT_KEY || c.env.ADMIN_SESSION_SECRET || ''; }
async function vaultKey(c: Context<AppEnv>): Promise<string> {
  const secret = vaultSecret(c);
  if (secret.length < 32) throw new Error('Drive vault unavailable');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vbook-drive-v1:' + secret));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function configRequest(c: Context<AppEnv>, action: string, config?: DriveConfig): Promise<Response> {
  const username = c.get('username');
  return c.env.USER_STORAGE.get(c.env.USER_STORAGE.idFromName(`user:${username}`)).fetch(`https://storage.internal/drive-${action}`, {
    method: 'POST', headers: { 'X-Storage-User': username, 'Content-Type': 'application/json' }, body: config ? JSON.stringify(config) : undefined,
  });
}
async function readConfig(c: Context<AppEnv>): Promise<DriveConfig | null> {
  const response = await configRequest(c, 'get');
  if (!response.ok) throw new Error('Storage unavailable');
  return response.json<DriveConfig | null>();
}
async function unlock(c: Context<AppEnv>, config: DriveConfig): Promise<string> {
  return decryptPassword(await vaultKey(c), 'drive:' + c.get('username'), config.encryptedKey);
}

async function driveFetch(c: Context<AppEnv>, url: URL): Promise<Response> {
  const key = c.get('driveApiKey');
  if (!key) return new Response('Google Drive is not configured', { status: 503 });
  url.searchParams.set('key', key);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (response.ok) return response;
    if (response.status === 404) return new Response('Drive folder or file not found', { status: 404 });
    if (response.status === 429) return new Response('Google Drive rate limit', { status: 429, headers: { 'Retry-After': '60' } });
    return new Response('Google Drive unavailable', { status: 503 });
  } catch {
    return new Response('Google Drive unavailable', { status: 503 });
  }
}

async function folderMetadata(c: Context<AppEnv>, folderId: string): Promise<DriveItem | Response> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${folderId}`);
  url.searchParams.set('fields', 'id,name,mimeType,modifiedTime');
  url.searchParams.set('supportsAllDrives', 'true');
  const response = await driveFetch(c, url);
  return response.ok ? response.json<DriveItem>() : response;
}

async function listFolder(c: Context<AppEnv>, folderId: string): Promise<DriveItem[] | Response> {
  if (!DRIVE_ID.test(folderId)) return new Response('Invalid Drive folder', { status: 400 });
  const items: DriveItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
    url.searchParams.set('fields', 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime)');
    url.searchParams.set('orderBy', 'folder,name');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await driveFetch(c, url);
    if (!response.ok) return response;
    const data = await response.json<DriveListResponse>();
    if (data.incompleteSearch) return new Response('Google Drive returned incomplete results', { status: 503 });
    items.push(...(data.files || []).filter(item => safeDriveName(item.name) && (item.mimeType === FOLDER_MIME || !item.mimeType.startsWith('application/vnd.google-apps.'))));
    pageToken = data.nextPageToken;
    if (!pageToken) return items;
  }
  return new Response('Drive folder contains too many items', { status: 507 });
}

function drivePath(url: string): string[] | null {
  const pathname = new URL(url).pathname;
  // Some Android WebDAV clients resolve the absolute href returned by
  // PROPFIND against the configured mount path as if it were relative. Accept
  // the resulting repeated mount prefix without weakening path decoding.
  const raw = pathname.replace(/^(?:\/drive-webdav)+(?=\/|$)/, '') || '/';
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (/[\\\x00-\x1f\x7f]/.test(decoded)) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length > MAX_DEPTH || segments.some(segment => segment === '.' || segment === '..' || !safeDriveName(segment))) return null;
  return segments;
}

async function resolveItem(c: Context<AppEnv>, rootId: string, segments: string[]): Promise<{ item: DriveItem; parentId: string } | Response> {
  let parentId = rootId;
  let current: DriveItem = { id: rootId, name: '', mimeType: FOLDER_MIME };
  for (const [index, name] of segments.entries()) {
    const children = await listFolder(c, parentId);
    if (children instanceof Response) return children;
    const matches = children.filter(child => child.name === name);
    if (!matches.length) return new Response('Not Found', { status: 404 });
    if (matches.length > 1) return new Response('Duplicate names in Google Drive folder', { status: 409 });
    current = matches[0];
    if (index < segments.length - 1 && current.mimeType !== FOLDER_MIME) return new Response('Not Found', { status: 404 });
    if (current.mimeType === FOLDER_MIME) parentId = current.id;
  }
  return { item: current, parentId };
}

function itemHref(segments: string[], directory: boolean): string {
  const suffix = segments.map(encodeURIComponent).join('/');
  return `/drive-webdav/${suffix}${directory && suffix ? '/' : ''}`;
}

function propResponse(item: DriveItem, href: string, displayName: string): string {
  const directory = item.mimeType === FOLDER_MIME;
  const modified = item.modifiedTime ? new Date(item.modifiedTime) : new Date(0);
  const size = Number(item.size || 0);
  return `  <D:response>\n    <D:href>${escapeXml(href)}</D:href>\n    <D:propstat>\n      <D:prop>\n        <D:displayname>${escapeXml(displayName)}</D:displayname>\n        <D:resourcetype>${directory ? '<D:collection/>' : ''}</D:resourcetype>\n${directory ? '' : `        <D:getcontentlength>${Number.isSafeInteger(size) ? size : 0}</D:getcontentlength>\n        <D:getcontenttype>${escapeXml(item.mimeType || 'application/octet-stream')}</D:getcontenttype>\n`}        <D:getlastmodified>${modified.toUTCString()}</D:getlastmodified>\n        <D:creationdate>${modified.toISOString()}</D:creationdate>\n      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n    </D:propstat>\n  </D:response>\n`;
}

async function driveWebDavHandler(c: Context<AppEnv>): Promise<Response> {
  const config = await readConfig(c);
  if (!config) return c.text('Connect your Google Drive API key first', 404);
  const folderId = config.folderId;
  c.set('driveApiKey', await unlock(c, config));
  const segments = drivePath(c.req.url);
  if (!segments) return c.text('Forbidden', 403);
  const method = c.req.method;
  if (method === 'OPTIONS') return c.text('', 200, { Allow: 'OPTIONS, GET, HEAD, PROPFIND', DAV: '1' });
  if (!['GET', 'HEAD', 'PROPFIND'].includes(method)) return c.text('Method Not Allowed', 405, { Allow: 'OPTIONS, GET, HEAD, PROPFIND' });
  const resolved = await resolveItem(c, folderId, segments);
  if (resolved instanceof Response) return resolved;
  const { item } = resolved;
  const directory = item.mimeType === FOLDER_MIME;

  if (method === 'PROPFIND') {
    const depth = c.req.header('Depth') || '1';
    if (depth !== '0' && depth !== '1') return c.body('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', 403, { 'Content-Type': 'application/xml' });
    let xml = '<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n';
    // Preserve the request spelling for the self entry. Some clients identify
    // it by exact href equality and otherwise show it again as a child folder.
    const selfHref = new URL(c.req.url).pathname;
    xml += propResponse(item, selfHref, segments.at(-1) || 'Google Drive');
    if (directory) c.header('Content-Location', itemHref(segments, true));
    if (depth === '1' && directory) {
      const children = await listFolder(c, item.id);
      if (children instanceof Response) return children;
      const names = new Set<string>();
      for (const child of children) {
        if (names.has(child.name)) return c.text('Duplicate names in Google Drive folder', 409);
        names.add(child.name);
        xml += propResponse(child, itemHref([...segments, child.name], child.mimeType === FOLDER_MIME), child.name);
      }
    }
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'private, no-store');
    return c.body(`${xml}</D:multistatus>`, 207);
  }
  if (directory) return c.text('', 200, { 'Cache-Control': 'private, no-store' });
  const headers: Record<string, string> = {
    'Content-Type': item.mimeType || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (item.size && /^\d+$/.test(item.size)) headers['Content-Length'] = item.size;
  if (item.modifiedTime) headers['Last-Modified'] = new Date(item.modifiedTime).toUTCString();
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  return c.redirect(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(item.id)}&confirm=t`, 302);
}

export const driveWebDavApp = new Hono<AppEnv>();
driveWebDavApp.all('/', driveWebDavHandler);
driveWebDavApp.all('/*', driveWebDavHandler);

function sameOrigin(c: Context<AppEnv>): boolean {
  return c.req.header('X-VBook-Action') === 'drive' && c.req.header('Origin') === new URL(c.req.url).origin;
}

export const driveConfigApi = new Hono<AppEnv>();
driveConfigApi.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'Dữ liệu quá lớn.' }, 413) }));

driveConfigApi.use('*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
const onError = (_error: Error, c: Context<AppEnv>) => c.json({ error: 'Không đọc được cấu hình Drive. Vui lòng thử lại hoặc liên hệ người vận hành.' }, 503);
driveConfigApi.onError(onError);
driveWebDavApp.onError(onError);

driveConfigApi.get('/', async c => {
  const config = await readConfig(c);
  return c.json({ configured: Boolean(config), available: vaultSecret(c).length >= 32, hasApiKey: Boolean(config), url: `${new URL(c.req.url).origin}/drive-webdav/` });
});

driveConfigApi.put('/', async c => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  if (vaultSecret(c).length < 32) return c.json({ error: 'Máy chủ chưa bật lưu khóa an toàn. Liên hệ người vận hành; không gửi API key cho admin.' }, 503);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400);
  const input = body as Record<string, unknown>;
  const folderId = typeof input.url === 'string' ? extractDriveFolderId(input.url) : null;
  if (!folderId) return c.json({ error: 'Link thư mục Google Drive không hợp lệ.' }, 400);
  const stored = await readConfig(c);
  let key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!key && stored) key = await unlock(c, stored);
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(key)) return c.json({ error: 'Hãy nhập Google Drive API key của bạn.' }, 400);
  c.set('driveApiKey', key);
  const metadata = await folderMetadata(c, folderId);
  if (metadata instanceof Response) return c.json({ error: 'Không đọc được Drive. Kiểm tra API key, bật Google Drive API và quyền chia sẻ thư mục.' }, metadata.status === 404 ? 400 : metadata.status as 429 | 503);
  if (metadata.mimeType !== FOLDER_MIME) return c.json({ error: 'Link phải trỏ tới một thư mục Google Drive.' }, 400);
  const encryptedKey = await encryptPassword(await vaultKey(c), 'drive:' + c.get('username'), key);
  const response = await configRequest(c, 'set', { folderId, encryptedKey });
  if (!response.ok) return c.json({ error: 'Không lưu được kết nối Drive.' }, 503);
  return c.json({ configured: true, url: `${new URL(c.req.url).origin}/drive-webdav/` });
});

driveConfigApi.delete('/', async c => {
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const response = await configRequest(c, 'delete');
  if (!response.ok) return c.json({ error: 'Không ngắt được kết nối Drive.' }, 503);
  return new Response(null, { status: 204 });
});
